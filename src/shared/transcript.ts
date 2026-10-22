/**
 * 文字起こし(計画書 §5.3)と話者(§5.4)の結果の形。
 *
 * 時刻は**素材の時刻**で持つ(どの素材の何秒目か)。タイムラインの時刻で持つと、
 * カットを詰めたり並べ替えたりするたびにずれていく。タイムラインでの位置は、
 * その素材を使っているクリップから都度割り出す(`utteranceTimelineRange`)。
 */

export interface AsrJob {
  id: string
  path: string
  /** 素材の時刻(秒) */
  start: number
  end: number
}

export interface AsrWord {
  text: string
  /** 素材の時刻(秒) */
  start: number
  end: number
}

export interface AsrJobResult {
  id: string
  text: string
  words: AsrWord[]
}

export type AsrDevice = 'dml' | 'cuda' | 'cpu'

export type AsrWorkerMessage =
  | { type: 'status'; stage: 'download' | 'load'; percent: number; note: string }
  | { type: 'device'; device: AsrDevice; note?: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; result: AsrJobResult }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface TranscriptUtterance {
  id: string
  /** 声を拾った素材(ピンマイクがあればその人のマイク) */
  assetId: string
  /** 話者(出演者の名前)。分からなければ undefined */
  speaker?: string
  /** 素材の時刻(秒) */
  sourceStart: number
  sourceEnd: number
  text: string
  words: AsrWord[]
  /** ほかの人と声が重なっている */
  overlap: boolean
}

/**
 * 声の無い所で音声認識が出しがちな決まり文句(学習に使われた動画の締めの挨拶など)。
 * 発話の区間だけを認識にかけるので滅多に出ないが、出たら捨てる。
 */
const HALLUCINATIONS = [
  /^(ご視聴|ご清聴)ありがとうございました[。!！]?$/,
  /^チャンネル登録(よろしく|お願い)/,
  /^(字幕|翻訳)(:|：)/,
  /^[.。…・\s]+$/
]

/**
 * 音声認識の「繰り返しの暴走」: 同じ言葉が切れ目なく続き、発話の大半を占める
 * (「ヴィヴィヴィヴィ…」「彼女彼女彼女…」「私は 私は 私は…」)。雑音・音楽・聞き取れない言葉で起きる。
 *
 * 言葉は空白・句読点を除き、小文字にして比べる(「I'm going to get the car.」と「car. I'm going」の区切りの
 * 違いで見逃さない)。数える回数は言葉の長さで変える:
 * - 時刻を見ないとき(文字だけで決める): 人の掛け声(「いけいけいけ」「ラッシュ ラッシュ」)と見分けるため、
 *   2 種類以上の文字の言葉で、2〜4 文字は 10 回、5〜10 文字は 6 回、11 文字以上(文)は 4 回以上続いたもの。
 *   1 文字の繰り返し(叫び「うわああああ」・笑い「はははは」・伸ばす「えーーーー」)は人の声なので数えない
 * - 時刻が分かり、その所の話す速さが極端に遅い(1 秒に 1.5 文字未満が 3 秒以上)とき: 2 文字以上の言葉は
 *   3 回、1 文字は 5 回以上続けば作り話(「2分間2分間2分間2分間」を 10 秒・「んんんんん…」を 20 秒)。
 *   人が繰り返して言う言葉(「はいはいはい」「やばいやばいやばい」・笑い)は話す速さで言うので数えない
 */
const MAX_UNIT = 40
/** 繰り返しが発話のこれだけを占めたら、暴走とみなして捨てる */
const LOOP_SHARE = 0.6
/** これより遅い所(1 秒の文字数)の繰り返しは、少ない回数でも作り話とみなす */
const SLOW_CHARS_PER_SEC = 1.5
/** 遅さを見る最短の長さ(秒)。短い所の時刻は粗い(0.02 秒刻み・長さ 0 の言葉)ので見ない */
const SLOW_MIN_SEC = 3
/** 1 秒にこれより多い文字は人には話せない(早口の日本語でも 1 秒に 10 文字ほど) */
const FAST_CHARS_PER_SEC = 40
const FAST_MIN_CHARS = 20
/**
 * 言葉の時刻を足した長さに対して、これより少ない文字(1 秒に 0.4 文字)が 10 秒以上続く発話は作り話
 * (声の無い所に言葉の時刻を引き伸ばしたもの)。言葉の間の無音は数えないので、間を空けて話した発話は当たらない
 */
const SPARSE_CHARS_PER_SEC = 0.4
const SPARSE_MIN_SEC = 10
/** 発話をまたいだ繰り返しを見るとき、これより間が空いた発話どうしはつながない(秒) */
const ACROSS_GAP_SEC = 1

/** 比べるための文字(空白・句読点を除き小文字に) */
const SKIP_CHAR = /[\s\p{P}]/u

function normalizedChars(text: string): string[] {
  const out: string[] = []
  for (const ch of text) if (!SKIP_CHAR.test(ch)) out.push(ch.toLowerCase())
  return out
}

interface Loop {
  from: number
  to: number
}

/**
 * 繰り返しを左から探す。`qualifies(単位の長さ, 回数, 範囲)` が作り話と認めた中で一番長く覆うものを取る
 */
function findLoops(
  chars: readonly string[],
  qualifies: (unit: readonly string[], repeats: number, from: number, to: number) => boolean
): Loop[] {
  const n = chars.length
  const out: Loop[] = []
  for (let i = 0; i < n;) {
    let best: Loop | null = null
    for (let L = 1; L <= MAX_UNIT && i + 2 * L <= n; L++) {
      let r = 1
      outer: while (i + (r + 1) * L <= n) {
        for (let k = 0; k < L; k++) if (chars[i + k] !== chars[i + r * L + k]) break outer
        r++
      }
      if (r < 2) continue
      const to = i + r * L
      if (best && to - i <= best.to - best.from) continue
      if (qualifies(chars.slice(i, i + L), r, i, to)) best = { from: i, to }
    }
    if (best) {
      out.push(best)
      i = best.to
    } else i++
  }
  return out
}

/** 文字だけで決める繰り返しの暴走(時刻を見ない) */
function strictLoop(unit: readonly string[], repeats: number): boolean {
  if (new Set(unit).size < 2) return false
  const L = unit.length
  return repeats >= (L <= 4 ? 10 : L <= 10 ? 6 : 4)
}

/** 速さを見たときの、少ない回数の繰り返し */
function slowLoop(unit: readonly string[], repeats: number): boolean {
  return repeats >= (new Set(unit).size < 2 ? 5 : 3)
}

function repetitionLoopLength(t: string): number {
  const chars = normalizedChars(t)
  let covered = 0
  for (const l of findLoops(chars, strictLoop)) covered += l.to - l.from
  return chars.length === 0 ? 0 : (covered / chars.length) * t.length
}

/** 決まり文句の作り話(「ご視聴ありがとうございました」など。本当に言うこともある)か */
export function isStockHallucination(text: string): boolean {
  const t = text.trim()
  return t !== '' && HALLUCINATIONS.some((r) => r.test(t))
}

/** 文字だけで見た作り話(決まり文句・長い繰り返し)。時刻が分かるなら `hallucinatedIndices` も使う */
export function isLikelyHallucination(text: string): boolean {
  const t = text.trim()
  if (t === '' || HALLUCINATIONS.some((r) => r.test(t))) return true
  return repetitionLoopLength(t) >= t.length * LOOP_SHARE
}

/** 時刻の付いた文字起こしの1片(発話・区切り) */
export interface TimedText {
  text: string
  start: number
  end: number
  words?: readonly { start: number; end: number; text?: string }[]
}

/** 言葉の時刻の幅(頭から終わり)と、言葉の長さの合計 */
function spans(item: TimedText): { span: number; spoken: number } {
  const ws = item.words?.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end)) ?? []
  if (ws.length === 0) {
    const d = Math.max(0, item.end - item.start)
    return { span: d, spoken: d }
  }
  let spoken = 0
  for (const w of ws) spoken += Math.max(0, w.end - w.start)
  const span = Math.max(0, ws[ws.length - 1].end - ws[0].start)
  return { span, spoken }
}

/**
 * 同じ素材の文字起こしの片のうち、作り話のもの(の添字)。片は時刻の順でなくてよい。
 * - 繰り返しの暴走(上の規則。発話をまたいで続くものも、間が 1 秒以内ならつないで見る)が片の 6 割以上
 * - 話す速さに対して文字が極端に多い(1 秒に 40 文字を超える)・少ない(言葉の長さの合計 10 秒以上に 1 秒 0.4 文字未満)
 * 決まり文句(「ご視聴ありがとうございました」)はここでは見ない(`isStockHallucination`)
 */
export function hallucinatedIndices(items: readonly TimedText[]): Set<number> {
  const drop = new Set<number>()
  const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start)
  let group: number[] = []
  const flush = (): void => {
    if (group.length > 0) loopsAcross(items, group, drop)
    group = []
  }
  for (const i of order) {
    const it = items[i]
    const n = normalizedChars(it.text).length
    const { span, spoken } = spans(it)
    if (n >= FAST_MIN_CHARS && n > FAST_CHARS_PER_SEC * span) drop.add(i)
    // 長さ 0 の片(言葉がみな同じ時刻)は繰り返しを探す並びに入れない(作り話の繰り返しの途中に挟まると、
    // 繰り返しが2つに分かれて回数が足りなくなる)
    if (span <= 1e-6) continue
    // 少なすぎる文字は、言葉の時刻があるときだけ見る(区切りの時刻だけの片は、無音をまたいで長いことがある)
    const timedWords = (it.words?.length ?? 0) > 0
    if (timedWords && n > 0 && spoken >= SPARSE_MIN_SEC && n < SPARSE_CHARS_PER_SEC * spoken)
      drop.add(i)
    if (drop.has(i)) continue
    const prev = group.length > 0 ? items[group[group.length - 1]] : null
    if (prev && it.start - prev.end > ACROSS_GAP_SEC) flush()
    group.push(i)
  }
  flush()
  return drop
}

/** つながった片の文字を並べて繰り返しを探し、6 割以上が繰り返しの片を `drop` に入れる */
function loopsAcross(
  items: readonly TimedText[],
  group: readonly number[],
  drop: Set<number>
): void {
  const chars: string[] = []
  const owner: number[] = []
  /** 文字ごとの話している長さ(片の言葉の長さを文字数で割る)。遅さを見るのに使う */
  const sec: number[] = []
  for (const i of group) {
    const cs = normalizedChars(items[i].text)
    const per = cs.length > 0 ? spans(items[i]).spoken / cs.length : 0
    for (const c of cs) {
      chars.push(c)
      owner.push(i)
      sec.push(per)
    }
  }
  if (chars.length < 2) return
  const prefix = [0]
  for (const s of sec) prefix.push(prefix[prefix.length - 1] + s)
  const loops = findLoops(chars, (unit, repeats, from, to) => {
    if (strictLoop(unit, repeats)) return true
    const d = prefix[to] - prefix[from]
    return d >= SLOW_MIN_SEC && to - from < SLOW_CHARS_PER_SEC * d && slowLoop(unit, repeats)
  })
  if (loops.length === 0) return
  const covered = new Map<number, number>()
  for (const l of loops)
    for (let k = l.from; k < l.to; k++) covered.set(owner[k], (covered.get(owner[k]) ?? 0) + 1)
  for (const i of group) {
    const n = normalizedChars(items[i].text).length
    if (n > 0 && (covered.get(i) ?? 0) >= n * LOOP_SHARE) drop.add(i)
  }
}

/** クリップの形(タイムラインでの位置を割り出すのに要る所だけ) */
export interface PlacedClipRef {
  assetId: string
  startTime: number
  inPoint: number
  outPoint: number
  speed?: number
}

/**
 * 発話がタイムラインのどこにあるか。その素材を使っているクリップのうち、発話の頭を含むものから割り出す。
 * どのクリップにも入っていなければ null(カットで落とした部分の発話)。
 */
export function utteranceTimelineRange(
  u: Pick<TranscriptUtterance, 'assetId' | 'sourceStart' | 'sourceEnd'>,
  clips: readonly PlacedClipRef[]
): { start: number; end: number } | null {
  for (const c of clips) {
    if (c.assetId !== u.assetId) continue
    if (u.sourceStart < c.inPoint - 1e-6 || u.sourceStart >= c.outPoint) continue
    const speed = c.speed && c.speed > 0 ? c.speed : 1
    const start = c.startTime + (u.sourceStart - c.inPoint) / speed
    const end = c.startTime + (Math.min(u.sourceEnd, c.outPoint) - c.inPoint) / speed
    return { start, end }
  }
  return null
}

/**
 * 区間を指定して文字起こしした結果を、その区間に収める。
 * - 認識の作り話(無音・雑音で出る「ご視聴ありがとうございました」・同じ言葉の繰り返し)は捨てる
 * - 区間の終わりより後ろで始まる言葉は捨て、時刻は区間の中に収める
 * (自動のテロップ・カラオケが、無音の所に出たり、クリップの終わりより 20 秒以上後ろに置かれたりしていた)
 */
export function fitSegmentsToRange<
  S extends {
    start: number
    end: number
    text: string
    words?: { start: number; end: number; text: string }[]
  }
>(
  segments: readonly S[],
  rangeStart: number,
  rangeEnd: number,
  /**
   * その時刻の音がほぼ無音か。決まり文句(「ご視聴ありがとうございました」)は、無音の所に出たときだけ
   * 作り話として捨てる(番組の締めで本当に言った言葉まで、テロップから消えていた)。省略時は常に捨てる
   */
  isQuiet?: (start: number, end: number) => boolean
): S[] {
  const clamp = (t: number): number => Math.min(rangeEnd, Math.max(rangeStart, t))
  // 繰り返しの作り話(区切りをまたいで続くもの・話す速さに合わないものも)と、長さ 0 の区切り
  // (言葉がみな同じ時刻)は、音が鳴っていても捨てる。音楽・効果音の所で「I'm going to get the car.」を
  // 13 回、長さ 0 の区切りを出していた
  const made = hallucinatedIndices(segments)
  const out: S[] = []
  for (const [si, seg] of segments.entries()) {
    if (made.has(si) || spans(seg).span <= 1e-6) continue
    if (isLikelyHallucination(seg.text)) {
      // 決まり文句だけなら、音が鳴っている所のものは本当の言葉として残す(繰り返しの作り話は常に捨てる)
      const t = seg.text.trim()
      const repetition = repetitionLoopLength(t) >= t.length * LOOP_SHARE
      const spoken = isQuiet !== undefined && !isQuiet(seg.start, seg.end)
      if (!(isStockHallucination(t) && !repetition && spoken)) continue
    }
    if (!seg.words) {
      if (seg.start >= rangeEnd) continue
      out.push({ ...seg, start: clamp(seg.start), end: Math.max(clamp(seg.start), clamp(seg.end)) })
      continue
    }
    const words = seg.words
      .filter((w) => w.start < rangeEnd)
      .map((w) => ({ ...w, start: clamp(w.start), end: Math.max(clamp(w.start), clamp(w.end)) }))
    if (words.length === 0) continue
    out.push({
      ...seg,
      words,
      start: words[0].start,
      end: words[words.length - 1].end,
      text: words.map((w) => w.text).join('')
    })
  }
  return out
}

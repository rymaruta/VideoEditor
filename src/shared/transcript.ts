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
 * 音声認識の「繰り返しの暴走」: 同じ短い言葉(2 種類以上の文字)が切れ目なく続き、発話の大半を占める
 * (「ヴィヴィヴィヴィ…」「彼女彼女彼女…」「私は 私は 私は…」)。雑音・音楽・聞き取れない言葉で起きる。
 * 人の掛け声(「いけいけいけ」「ラッシュ ラッシュ」)と見分けるため、短い言葉(2〜4 文字)は 10 回以上、
 * 長い言葉(5〜10 文字)は 6 回以上続いたものだけを数える。1 文字の繰り返し(叫び「うわああああ」・
 * 笑い「はははは」・伸ばす「えーーーー」)は人の声なので数えない
 */
const REPETITION_LOOP = /(\S.{1,9}?)(?:[\s、。,.!！]*\1){5,}/gu
/** 繰り返しが発話のこれだけを占めたら、暴走とみなして捨てる */
const LOOP_SHARE = 0.6

function repetitionLoopLength(t: string): number {
  let longest = 0
  for (const m of t.matchAll(REPETITION_LOOP)) {
    const unit = m[1].replace(/\s/g, '')
    // 同じ文字だけの単位(「はは」「ああ」)は 1 文字の繰り返し
    if (new Set(unit).size < 2) continue
    const repeats = m[0].split(m[1]).length - 1
    if (repeats < ([...unit].length <= 4 ? 10 : 6)) continue
    longest = Math.max(longest, m[0].length)
  }
  return longest
}

/** 決まり文句の作り話(「ご視聴ありがとうございました」など。本当に言うこともある)か */
export function isStockHallucination(text: string): boolean {
  const t = text.trim()
  return t !== '' && HALLUCINATIONS.some((r) => r.test(t))
}

export function isLikelyHallucination(text: string): boolean {
  const t = text.trim()
  if (t === '' || HALLUCINATIONS.some((r) => r.test(t))) return true
  return repetitionLoopLength(t) >= t.length * LOOP_SHARE
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
  const out: S[] = []
  for (const seg of segments) {
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

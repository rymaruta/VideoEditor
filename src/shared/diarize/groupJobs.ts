import { isStockHallucination, type AsrJob, type AsrWord } from '../transcript'

/**
 * 文字起こしの速さのため、同じマイクで続く発話を1つの区間にまとめて認識する(計画書 §5.3)。
 *
 * whisper は 30 秒の窓ごとに音を読むので、3 秒の発話でも 30 秒ぶんの計算をする。続く発話を 28 秒までの1つの窓に
 * まとめれば、窓の数(=重い計算の回数)が減る。結果は単語ごとの時刻で、元の発話へ振り分ける。
 * 発話の外の単語(ほかの人の声の回り込み・言い間違えの空白)は捨てる。
 */
export const GROUP_WINDOW_SEC = 28
/** 発話の間がこれより空いていたら、まとめない(長い無音を読ませない) */
export const GROUP_MAX_GAP_SEC = 6
/** 単語を発話へ振り分けるときの余裕(秒) */
const ASSIGN_MARGIN = 0.25

export interface GroupedJob extends AsrJob {
  /** まとめた元の発話(1本だけならまとめていない) */
  parts: { id: string; start: number; end: number }[]
}

export function groupAsrJobs(
  jobs: readonly AsrJob[],
  windowSec = GROUP_WINDOW_SEC,
  maxGapSec = GROUP_MAX_GAP_SEC
): GroupedJob[] {
  const sorted = [...jobs].sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start)
  const out: GroupedJob[] = []
  for (const j of sorted) {
    const g = out[out.length - 1]
    const fits =
      g &&
      g.path === j.path &&
      j.start - g.end <= maxGapSec &&
      Math.max(g.end, j.end) - g.start <= windowSec &&
      j.start >= g.end - 1e-6
    if (fits) {
      g.end = Math.max(g.end, j.end)
      g.parts.push({ id: j.id, start: j.start, end: j.end })
      g.id = `${g.parts[0].id}+${g.parts.length - 1}`
    } else out.push({ ...j, parts: [{ id: j.id, start: j.start, end: j.end }] })
  }
  return out
}

/** 言語を判定するのに読む、素材ごとの窓の数(長い順) */
export const LANGUAGE_PROBES_PER_PATH = 3

/**
 * 言語の自動判定に読む窓を、素材(マイク)ごとに選ぶ。声の多い窓(長い窓)から `perPath` 個まで。
 * 返すのは素材 → 窓の並び
 */
export function languageProbes(
  groups: readonly GroupedJob[],
  perPath = LANGUAGE_PROBES_PER_PATH
): Map<string, GroupedJob[]> {
  const byPath = new Map<string, GroupedJob[]>()
  for (const g of groups) {
    const list = byPath.get(g.path) ?? []
    list.push(g)
    byPath.set(g.path, list)
  }
  for (const [path, list] of byPath) {
    const speech = (g: GroupedJob): number => g.parts.reduce((t, p) => t + (p.end - p.start), 0)
    byPath.set(
      path,
      [...list].sort((a, b) => speech(b) - speech(a) || a.start - b.start).slice(0, perPath)
    )
  }
  return byPath
}

/**
 * Whisper が最初に出す言葉(言語の印 `<|ja|>` など)の確からしさ。`logits` は最初の言葉の点数、
 * `langToId` は言語の印 → 番号。返すのは言語の符号(`ja`)→ 確からしさ(言語の印の中で足して 1)
 */
export function languageProbs(
  logits: ArrayLike<number>,
  langToId: Readonly<Record<string, number>>
): Map<string, number> {
  const entries = Object.entries(langToId)
    .map(([token, id]) => [token.replace(/^<\|(.*)\|>$/, '$1'), logits[id]] as const)
    .filter(([, v]) => Number.isFinite(v))
  const out = new Map<string, number>()
  if (entries.length === 0) return out
  const max = Math.max(...entries.map(([, v]) => v))
  let z = 0
  for (const [, v] of entries) z += Math.exp(v - max)
  for (const [code, v] of entries) out.set(code, Math.exp(v - max) / z)
  return out
}

/** 窓ごとに判定した確からしさを平均する */
export function averageProbs(list: readonly ReadonlyMap<string, number>[]): Map<string, number> {
  const out = new Map<string, number>()
  if (list.length === 0) return out
  for (const m of list) for (const [k, v] of m) out.set(k, (out.get(k) ?? 0) + v / list.length)
  return out
}

/**
 * 言葉をつないで発話の文にする。英数字どうしの間だけ空ける(日本語は詰める)。
 *
 * `rawTokens` は、音声認識の片を前の空白ごと渡したとき(`asrWorker`)。認識は英数字の言葉を細かい片
 * (「Mine」「craft」、「15」「000」)で返すことがあり、英数字どうしの間をいつも空けると、文が
 * 「Mine craft」「15 000円」になってテロップにも出ていた。片の頭に空白があった所(「 morning」)だけ空ける
 */
function joinWords(words: readonly AsrWord[], rawTokens: boolean): string {
  let s = ''
  for (const w of words) {
    const t = w.text.trim()
    const spaced = rawTokens ? /^\s/.test(w.text) : true
    if (s && spaced && /[A-Za-z0-9]$/.test(s) && /^[A-Za-z0-9]/.test(t)) s += ' '
    s += t
  }
  return s
}

/**
 * まとめて認識した単語(素材の時刻)を、元の発話へ振り分ける。
 * `rawTokens` なら、単語は認識の片のまま(頭の空白を残したもの)。返す単語は空白を落とす
 */
export function splitGroupWords(
  group: GroupedJob,
  words: readonly AsrWord[],
  rawTokens = false
): { id: string; text: string; words: AsrWord[] }[] {
  const buckets = group.parts.map(() => [] as AsrWord[])
  for (const w of words) {
    const mid = (w.start + w.end) / 2
    let best = -1
    let bestDist = Infinity
    group.parts.forEach((p, i) => {
      const d = mid < p.start ? p.start - mid : mid > p.end ? mid - p.end : 0
      if (d <= ASSIGN_MARGIN && d < bestDist) {
        best = i
        bestDist = d
      }
    })
    if (best >= 0) buckets[best].push(w)
  }
  return group.parts.map((p, i) => ({
    id: p.id,
    text: joinWords(buckets[i], rawTokens),
    words: rawTokens
      ? buckets[i].map((w) => ({ ...w, text: w.text.trim() })).filter((w) => w.text.length > 0)
      : buckets[i]
  }))
}

/** 音声認識(transformers.js)の言葉の片。`segmentStart` は認識の区切りの頭の片(`markSegmentStarts`) */
export interface AsrRawChunk {
  text: string
  timestamp: [number, number | null]
  segmentStart?: boolean
}

const MARKED = Symbol.for('videoEditor.asrSegmentStarts')

/** 文字に戻せなかったバイトの印(U+FFFD) */
const REPLACEMENT = '\uFFFD'
/** 1文字(UTF-8 で最長 4 バイト)を割ったときに、区切りの終わりに残りうる片の数 */
const MAX_SPLIT_TOKENS = 4

/**
 * 片の並びの終わりで、文字の途中で切れている片の数(0 なら切れていない)。
 * 片はバイトの並び(Whisper の BPE)なので、多バイトの文字(「倅」= 3 バイト)が2つの片に分かれることがある。
 * 終わりの片を外していき、文字に戻した文の終わりから「�」が消える所までを、切れている片とする
 */
function splitTail(tokens: readonly unknown[], decode: (t: unknown[]) => string): number {
  if (tokens.length === 0 || !decode([...tokens]).endsWith(REPLACEMENT)) return 0
  for (let k = 1; k <= Math.min(MAX_SPLIT_TOKENS, tokens.length); k++) {
    const head = tokens.slice(0, tokens.length - k)
    if (head.length === 0 || !decode(head).endsWith(REPLACEMENT)) return k
  }
  return 0
}

/**
 * 認識の区切り(Whisper の時刻の区切り)の頭の言葉の片に `segmentStart` の印を付ける。
 * transformers.js は区切りごとに言葉を束ね(`collateWordTimestamps`)、区切りの文を空白を足さずにつなぐ。
 * 日本語に固定して英語を認識すると区切りの頭に空白が付かず、「I know」「I should」が「I knowI should」に
 * なっていた。束ねの関数を包んで、区切りの頭の片が分かるようにする。包めなければ false(何もしない)
 *
 * あわせて、区切りの境目で割れた多バイトの文字をつなぐ。束ねは区切りごとに片を文字へ戻すので、文字の途中で
 * 区切りが入ると、前の区切りの終わりと次の区切りの頭がそれぞれ「�」になっていた(実地テスト:
 * 「十三四の倅」が「十三子の�狼」)。前の区切りの終わりの割れた片を外して、次の区切りの頭へつないでから
 * 文字に戻す。1回の認識(`_decode_asr`)の終わりまで残った片は捨てる
 */
export function markSegmentStarts(asr: unknown): boolean {
  const tokenizer = (asr as { tokenizer?: Record<string | symbol, unknown> } | null)?.tokenizer
  const collate = tokenizer?.collateWordTimestamps
  if (!tokenizer || typeof collate !== 'function') return false
  if (tokenizer[MARKED]) return true
  let carry: { tokens: unknown[]; ts: unknown[] } = { tokens: [], ts: [] }
  const decodeAsr = tokenizer._decode_asr
  if (typeof decodeAsr === 'function')
    tokenizer._decode_asr = function (this: unknown, ...args: unknown[]): unknown {
      carry = { tokens: [], ts: [] }
      try {
        return (decodeAsr as (...a: unknown[]) => unknown).apply(this, args)
      } finally {
        carry = { tokens: [], ts: [] }
      }
    }
  tokenizer.collateWordTimestamps = function (
    this: { decode?: (t: unknown[]) => string },
    ...args: unknown[]
  ): unknown {
    let [tokens, ts] = args as [unknown, unknown]
    if (Array.isArray(tokens) && Array.isArray(ts) && typeof this?.decode === 'function') {
      if (carry.tokens.length > 0) {
        tokens = [...carry.tokens, ...tokens]
        ts = [...carry.ts, ...ts]
        carry = { tokens: [], ts: [] }
      }
      const list = tokens as unknown[]
      const k = splitTail(list, (t) => this.decode!(t))
      if (k > 0) {
        carry = {
          tokens: list.slice(list.length - k),
          ts: (ts as unknown[]).slice(list.length - k)
        }
        tokens = list.slice(0, list.length - k)
        ts = (ts as unknown[]).slice(0, list.length - k)
      }
      args = [tokens, ts, ...args.slice(2)]
      if ((tokens as unknown[]).length === 0) return []
    }
    const words = (collate as (...a: unknown[]) => unknown).apply(this, args)
    if (Array.isArray(words) && words.length > 0 && words[0] && typeof words[0] === 'object')
      (words[0] as AsrRawChunk).segmentStart = true
    return words
  }
  tokenizer[MARKED] = true
  return true
}

/**
 * 区切りの前の片の終わり: 英数字か、英字の後ろの句読点(「given.」「here,」)。英語に固定しても区切りの頭の
 * 片に空白が付かず、「given.The」「here,you're」になっていた(実地テストの英語の確認)
 */
const ALNUM_END = /(?:[A-Za-z0-9]|[A-Za-z][.,!?;:])$/
const ALNUM_START = /^[A-Za-z0-9]/

/**
 * 区切りの頭の片で、前の片の英数字と空白なしで続いているものの頭に空白を足す(英語など空白で区切る言語の
 * 語の間)。区切りの中で続いていた片(「Mine」「craft」)・日本語はそのまま
 */
export function spaceSegmentStarts<T extends { text: string; segmentStart?: boolean }>(
  chunks: readonly T[]
): T[] {
  let prev = ''
  return chunks.map((c) => {
    const spaced =
      c.segmentStart && !/^\s/.test(c.text) && ALNUM_END.test(prev) && ALNUM_START.test(c.text)
    if (c.text.trim().length > 0) prev = c.text.trimEnd()
    return spaced ? { ...c, text: ` ${c.text}` } : c
  })
}

/**
 * 認識の文(`text`)の、区切りの頭で英数字どうしが続いた所に空白を入れる。文を片の順に読んで位置を合わせ、
 * 合わなくなったらそこから先は変えない(日本語の文の空白・句読点は変えない)
 */
function spaceTextAtSegments(text: string, chunks: readonly AsrRawChunk[]): string {
  let out = ''
  let cursor = 0
  for (const c of chunks) {
    if (c.text.length === 0) continue
    // 文にだけある空白(文の頭など)は写して進む
    while (!text.startsWith(c.text, cursor) && /\s/.test(text[cursor] ?? '')) out += text[cursor++]
    if (!text.startsWith(c.text, cursor)) break
    if (
      c.segmentStart &&
      cursor > 0 &&
      ALNUM_END.test(text.slice(0, cursor)) &&
      ALNUM_START.test(c.text)
    )
      out += ' '
    out += c.text
    cursor += c.text.length
  }
  return out + text.slice(cursor)
}

/** 文字に戻せなかったバイト(「�」)を落とす。テロップに「�」を出さない */
function dropBroken(text: string): string {
  return text.includes(REPLACEMENT) ? text.split(REPLACEMENT).join('') : text
}

/** 窓の音の終わりより後ろで始まる片を、無音で埋めた所の作り話とみなす余裕(秒)。言葉の時刻の粗さぶん */
const PAD_TOLERANCE_SEC = 0.5

/**
 * 言葉の片の時刻(窓の頭からの秒)を直す。直せない片(窓の音の外)は null。
 *
 * 認識は音を 30 秒の窓に足りない所まで無音で埋めて読むので、埋めた所(音の終わりより後ろ)に作り話の片を
 * 置くことがある。また最後の片の終わりは、transformers.js が足した終わりの印の時刻(0 秒)になることがある
 * (`_generate_with_seek` が終わりの印の時刻を 0 で埋める)。そのまま足すと、終わりが始まりより前の言葉
 * (595.67→571.99)になり、真ん中の時刻で振り分けると発話の範囲から 15 秒外れた言葉が発話に入っていた。
 * - 始まりが音の終わりより後ろの片は捨てる(音の終わりへ押し込むと、最後の発話へ振り分けられてしまう)
 * - 終わりが分からない・始まりより前なら、次の片の始まり(無ければ音の終わり)までとする
 * - 正しい時刻は縮めない(話す速さの判定に使うので、発話の範囲で切り詰めない)
 */
function windowTimes(
  chunks: readonly AsrRawChunk[],
  dur: number
): ({ start: number; end: number } | null)[] {
  const starts = chunks.map((c) => {
    const t = c.timestamp[0]
    if (!Number.isFinite(t) || t > dur + PAD_TOLERANCE_SEC) return null
    return Math.max(0, t)
  })
  return chunks.map((c, i) => {
    const start = starts[i]
    if (start === null) return null
    const raw = c.timestamp[1]
    if (raw !== null && Number.isFinite(raw) && raw >= c.timestamp[0]) return { start, end: raw }
    let next = Math.max(start, dur)
    for (let j = i + 1; j < chunks.length; j++) {
      const sj = starts[j]
      if (sj !== null && sj >= start) {
        next = sj
        break
      }
    }
    return { start, end: Math.max(start, next) }
  })
}

/**
 * 窓の音の終わり(`dur`)より後ろで始まる・終わりをまたぐ片のうち、決まり文句の作り話
 * (「ご視聴ありがとうございました」など。`isStockHallucination`)になる所を捨てる(`times` を null にする)。
 * 音の終わりの少し後ろ(余裕 0.5 秒の中)に出た作り話が最後の発話の文につながると、文全体では決まり文句に
 * 当たらず、作り話の除外をすり抜けていた。その片から文の終わりまでが決まり文句なら全部、その片だけが
 * 決まり文句ならその片を捨てる。音の外でも決まり文句でない片(「ね」など)は残す
 */
function dropTailStock(
  chunks: readonly AsrRawChunk[],
  times: ({ start: number; end: number } | null)[],
  dur: number
): void {
  for (let i = 0; i < chunks.length; i++) {
    const t = times[i]
    if (!t || !(t.start > dur || t.end > dur)) continue
    const tail = chunks
      .slice(i)
      .filter((_, k) => times[i + k] !== null)
      .map((c) => c.text)
      .join('')
    if (isStockHallucination(tail)) {
      for (let k = i; k < chunks.length; k++) times[k] = null
      return
    }
    if (isStockHallucination(chunks[i].text)) times[i] = null
  }
}

/**
 * まとめて認識した窓(`group`)の結果を、元の発話ごとの結果にする。言葉の時刻は素材の時刻に直す
 * (発話の範囲で切り詰めはしない)。窓の音の外の片・音の終わりの後ろの決まり文句の作り話は捨てる
 */
export function asrGroupResults(
  group: GroupedJob,
  text: string,
  chunks: readonly AsrRawChunk[]
): { id: string; text: string; words: AsrWord[] }[] {
  const dur = Math.max(0, group.end - group.start)
  const times = windowTimes(chunks, dur)
  dropTailStock(chunks, times, dur)
  const keptChunks = chunks.filter((_, i) => times[i] !== null)
  const keptTimes = times.filter((t): t is { start: number; end: number } => t !== null)
  const spaced = spaceSegmentStarts(keptChunks)
  // 片の頭の空白は、まとめた発話の文を作るまで残す(認識の片「Mine」「craft」を「Mine craft」と
  // 空けないよう、空白のあった所だけ空ける。`splitGroupWords`)
  const tokens = spaced
    .map((c, i) => ({
      text: dropBroken(c.text),
      start: group.start + keptTimes[i].start,
      end: group.start + keptTimes[i].end
    }))
    .filter((w) => w.text.trim().length > 0)
  if (group.parts.length === 1) {
    // 1件だけなら認識の文をそのまま使う(日本語の文の空白・句読点を変えない)。区切りの頭だけ空ける。
    // 文に「�」がある(割れた文字を区切りの間でつないだ。`markSegmentStarts`)・音の外の片を捨てたときは、
    // 残した片から文を作り直す
    const words = tokens.map((w) => ({ ...w, text: w.text.trim() }))
    const body =
      text.includes(REPLACEMENT) || keptChunks.length < chunks.length
        ? spaced.map((c) => c.text).join('')
        : spaceTextAtSegments(text, chunks)
    return [{ id: group.parts[0].id, text: dropBroken(body).trim(), words }]
  }
  return splitGroupWords(group, tokens, true)
}

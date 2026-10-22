import type { AsrJob, AsrWord } from '../transcript'

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

/**
 * 認識の区切り(Whisper の時刻の区切り)の頭の言葉の片に `segmentStart` の印を付ける。
 * transformers.js は区切りごとに言葉を束ね(`collateWordTimestamps`)、区切りの文を空白を足さずにつなぐ。
 * 日本語に固定して英語を認識すると区切りの頭に空白が付かず、「I know」「I should」が「I knowI should」に
 * なっていた。束ねの関数を包んで、区切りの頭の片が分かるようにする。包めなければ false(何もしない)
 */
export function markSegmentStarts(asr: unknown): boolean {
  const tokenizer = (asr as { tokenizer?: Record<string | symbol, unknown> } | null)?.tokenizer
  const collate = tokenizer?.collateWordTimestamps
  if (!tokenizer || typeof collate !== 'function') return false
  if (tokenizer[MARKED]) return true
  tokenizer.collateWordTimestamps = function (this: unknown, ...args: unknown[]): unknown {
    const words = (collate as (...a: unknown[]) => unknown).apply(this, args)
    if (Array.isArray(words) && words.length > 0 && words[0] && typeof words[0] === 'object')
      (words[0] as AsrRawChunk).segmentStart = true
    return words
  }
  tokenizer[MARKED] = true
  return true
}

const ALNUM_END = /[A-Za-z0-9]$/
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

/**
 * まとめて認識した窓(`group`)の結果を、元の発話ごとの結果にする。言葉の時刻は素材の時刻に直す
 */
export function asrGroupResults(
  group: GroupedJob,
  text: string,
  chunks: readonly AsrRawChunk[]
): { id: string; text: string; words: AsrWord[] }[] {
  // 片の頭の空白は、まとめた発話の文を作るまで残す(認識の片「Mine」「craft」を「Mine craft」と
  // 空けないよう、空白のあった所だけ空ける。`splitGroupWords`)
  const tokens = spaceSegmentStarts(chunks)
    .map((c) => ({
      text: c.text,
      start: group.start + c.timestamp[0],
      end: group.start + (c.timestamp[1] ?? c.timestamp[0])
    }))
    .filter((w) => w.text.trim().length > 0)
  if (group.parts.length === 1) {
    // 1件だけなら認識の文をそのまま使う(日本語の文の空白・句読点を変えない)。区切りの頭だけ空ける
    const words = tokens.map((w) => ({ ...w, text: w.text.trim() }))
    return [{ id: group.parts[0].id, text: spaceTextAtSegments(text, chunks).trim(), words }]
  }
  return splitGroupWords(group, tokens, true)
}

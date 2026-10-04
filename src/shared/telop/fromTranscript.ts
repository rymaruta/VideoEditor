import type { AsrWord, TranscriptUtterance } from '../transcript'
import { applyDictionary, balancedLineEnds, removeFillers, type DictionaryEntry } from './polish'

/**
 * 発話を発言テロップの単位に区切る(計画書 §5.8 の手前の、仮の整形)。
 *
 * - 1枚は最大2行・1行 `maxLineChars` 文字まで。句読点の位置で優先して区切る
 * - 文末の「。」は付けない(テロップでは付けないのが普通)。文中の「、」は空白にする
 * - 表示時間は、その部分の言葉の時刻から取る。短すぎると読めないので最低 `minDurationSec` 秒
 * - **言葉そのものは変えない**(言い換え・要約はしない。計画書 §5.8 の厳守事項)
 */

export interface TelopChunk {
  text: string
  /** 素材の時刻 */
  sourceStart: number
  sourceEnd: number
}

export interface ChunkOptions {
  maxLineChars?: number
  maxLines?: number
  minDurationSec?: number
  /** 言いよどみを除く(既定は除く) */
  removeFillers?: boolean
  /** 用語の辞書 */
  dictionary?: readonly DictionaryEntry[]
}

/** 表示用に整える(句点を落とし、読点を空白に) */
export function tidyTelopText(text: string): string {
  return text
    .replace(/[、,]\s*/g, ' ')
    .replace(/[。.]+$/u, '')
    .replace(/[。]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 文字単位の時刻(言葉の時刻を文字数で按分する) */
function charTimes(words: readonly AsrWord[]): { ch: string; start: number; end: number }[] {
  const out: { ch: string; start: number; end: number }[] = []
  for (const w of words) {
    // 英数字どうしの言葉の間は空ける(発話の文と同じ規則。詰めると「Helloworld」になり、言葉の途中で改行される)
    const prev = out[out.length - 1]
    if (prev && /[A-Za-z0-9]/.test(prev.ch) && /^[A-Za-z0-9]/.test(w.text))
      out.push({ ch: ' ', start: prev.end, end: prev.end })
    const chars = [...w.text]
    const step = chars.length > 0 ? (w.end - w.start) / chars.length : 0
    chars.forEach((ch, i) =>
      out.push({ ch, start: w.start + step * i, end: w.start + step * (i + 1) })
    )
  }
  return out
}

/** 1行に収まるよう改行を入れる(禁則を守り、句読点・助詞の後を優先) */
export function wrapTelopLines(text: string, maxLineChars: number): string[] {
  const chars = [...text]
  let from = 0
  return balancedLineEnds(chars, maxLineChars)
    .map((end) => {
      const line = chars.slice(from, end).join('').trim()
      from = end
      return line
    })
    .filter((l) => l.length > 0)
}

export function utteranceToTelopChunks(
  u: Pick<TranscriptUtterance, 'text' | 'words' | 'sourceStart' | 'sourceEnd'>,
  options: ChunkOptions = {}
): TelopChunk[] {
  const maxLine = options.maxLineChars ?? 14
  const maxLines = options.maxLines ?? 2
  const minDur = options.minDurationSec ?? 1.0

  const timed = u.words.length > 0 ? charTimes(u.words) : []
  const raw = timed.length > 0 ? timed.map((c) => c.ch).join('') : u.text
  const chars = [...raw]
  // 1枚の長さを揃えて区切ってから、1枚ずつ改行する。前から1枚ずつ上限まで詰めると、最後の1枚が
  // 数文字だけになり(「ある」だけが 1.8秒出る)、詰めた1枚は禁則の位置しだいで3行になる。
  // 1枚の上限は 行数×1行 より少し短くし、改行の位置を選ぶ余地を残す(余地が無いと3行になる)
  const sheetMax = Math.max(maxLine, maxLine * maxLines - Math.ceil(maxLine / 8))
  const ends = balancedLineEnds(chars, sheetMax)
  const pieces = ends.map((end, i) => ({ from: i === 0 ? 0 : ends[i - 1], to: end }))

  const polish = (text: string): string => {
    let body = text
    if (options.removeFillers !== false) body = removeFillers(body)
    if (options.dictionary?.length) body = applyDictionary(body, options.dictionary)
    return tidyTelopText(body)
  }
  // 言葉の時刻が無いときは、発話の時間を文字数で割り振る(全部の枚を発話の頭からにすると、
  // 重ならないように詰めた結果、最後の1枚以外が長さ 0 になる)
  const timeAt = (i: number): number =>
    u.sourceStart + ((u.sourceEnd - u.sourceStart) * i) / Math.max(1, chars.length)
  const chunks: TelopChunk[] = []
  for (const p of pieces) {
    // 言いよどみを除く・辞書で直すと長さが変わるので、整えた文で改行し直す
    const polished = polish(chars.slice(p.from, p.to).join(''))
    const text = wrapTelopLines(polished, maxLine).join('\n')
    if (!text) continue
    // 頭の、整えると消える文字(言いよどみ・句読点・空白)は時刻に入れない
    // (「えーと、」と言っているあいだから次の言葉を出さない)
    // 1文字ずつ削ると「ーと、」のように言いよどみの途中で別の文字列になるので、
    // 整えた結果が変わらない一番後ろの頭を探す
    let from = p.from
    const to = p.to
    for (let k = p.from + 1; k < to; k++)
      if (polish(chars.slice(k, to).join('')) === polished) from = k
    const start = timed.length > 0 ? timed[from].start : timeAt(from)
    const end = timed.length > 0 ? timed[to - 1].end : timeAt(to)
    chunks.push({
      text,
      sourceStart: start,
      sourceEnd: Math.max(end, start + minDur)
    })
  }
  // 次のテロップに重ならないように(最低表示時間で伸ばした分を詰める)
  for (let k = 0; k < chunks.length - 1; k++) {
    chunks[k].sourceEnd = Math.min(chunks[k].sourceEnd, chunks[k + 1].sourceStart)
  }
  return chunks
}

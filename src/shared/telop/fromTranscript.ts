import type { AsrWord, TranscriptUtterance } from '../transcript'

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
    const chars = [...w.text]
    const step = chars.length > 0 ? (w.end - w.start) / chars.length : 0
    chars.forEach((ch, i) =>
      out.push({ ch, start: w.start + step * i, end: w.start + step * (i + 1) })
    )
  }
  return out
}

const BREAK_AFTER = /[、。！？!?,.\s]/u

/** 1行に収まるよう改行を入れる(句読点の後を優先、無ければ文字数で) */
export function wrapTelopLines(text: string, maxLineChars: number): string[] {
  const chars = [...text]
  const lines: string[] = []
  let i = 0
  while (i < chars.length) {
    if (chars.length - i <= maxLineChars) {
      lines.push(chars.slice(i).join('').trim())
      break
    }
    let cut = -1
    // 行の後ろ半分にある区切りを探す
    for (let k = i + maxLineChars; k > i + Math.floor(maxLineChars / 2); k--) {
      if (BREAK_AFTER.test(chars[k - 1])) {
        cut = k
        break
      }
    }
    if (cut < 0) cut = i + maxLineChars
    lines.push(chars.slice(i, cut).join('').trim())
    i = cut
  }
  return lines.filter((l) => l.length > 0)
}

export function utteranceToTelopChunks(
  u: Pick<TranscriptUtterance, 'text' | 'words' | 'sourceStart' | 'sourceEnd'>,
  options: ChunkOptions = {}
): TelopChunk[] {
  const maxLine = options.maxLineChars ?? 14
  const maxLines = options.maxLines ?? 2
  const minDur = options.minDurationSec ?? 1.0
  const perChunk = maxLine * maxLines

  const timed = u.words.length > 0 ? charTimes(u.words) : []
  const raw = timed.length > 0 ? timed.map((c) => c.ch).join('') : u.text
  // 1枚に収まる長さで、句読点の位置を優先して切る
  const pieces: { from: number; to: number }[] = []
  const chars = [...raw]
  let i = 0
  while (i < chars.length) {
    let to = Math.min(chars.length, i + perChunk)
    if (to < chars.length) {
      for (let k = to; k > i + Math.floor(perChunk / 2); k--) {
        if (BREAK_AFTER.test(chars[k - 1])) {
          to = k
          break
        }
      }
    }
    pieces.push({ from: i, to })
    i = to
  }

  const chunks: TelopChunk[] = []
  for (const p of pieces) {
    const text = tidyTelopText(chars.slice(p.from, p.to).join(''))
    if (!text) continue
    const start = timed.length > 0 ? timed[p.from].start : u.sourceStart
    const end = timed.length > 0 ? timed[p.to - 1].end : u.sourceEnd
    chunks.push({
      text: wrapTelopLines(text, maxLine).join('\n'),
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

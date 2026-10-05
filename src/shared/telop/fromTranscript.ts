import type { AsrWord, TranscriptUtterance } from '../transcript'
import { applyDictionary, balancedLineEnds, removeFillers, type DictionaryEntry } from './polish'
import { MIN_DISPLAY_SEC, READ_CHARS_PER_SEC } from '../qc/telop'

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

/**
 * 発話の最初の1枚を、発話の区間の頭から何秒後に出すか。発話の区間は話者の判定の余白(0.15 秒)の分だけ
 * 声より前から始まり、30分の回では本人のマイクで声が立ち上がるのは区間の頭の 0.16〜0.23 秒後(中央値 0.20)。
 * 0.12 秒後に出すと、声の 0.08 秒(2〜3フレーム)前に出る
 */
export const FIRST_TELOP_DELAY_SEC = 0.12

/** 表示用に整える(句点を落とし、読点を空白に。数字の桁区切り「2,800」のカンマは残す) */
export function tidyTelopText(text: string): string {
  return text
    .replace(/、\s*|,(?!\d)\s*|(?<!\d),\s*/g, ' ')
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
    let start = timed.length > 0 ? timed[from].start : timeAt(from)
    // 発話の最初の1枚は、言葉の時刻ではなく発話の頭(声を検出した区間の頭)から出す。
    // 音声認識の言葉の時刻は声より遅れがちで、30分の回(発話 361 件)では最初の1枚の 294/312 枚が
    // 本人の声より遅れて出ていた(中央値 0.11 秒、0.1 秒を超える遅れが 179 枚。テロップが声を追いかける)。
    // 区間の頭から `FIRST_TELOP_DELAY_SEC` 後に出すと、声のほんの少し前に出る。
    // 頭の言いよどみを除いた枚(from > 0)は、言いよどみのあいだに出さないよう言葉の時刻のまま
    if (from === 0 && timed.length > 0 && u.sourceStart < start)
      start = Math.max(u.sourceStart, Math.min(start, u.sourceStart + FIRST_TELOP_DELAY_SEC))
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

export interface SettleOptions {
  /** これより短い切れ目(秒)は、前のテロップを次の頭まで延ばしてつなぐ */
  bridgeSec?: number
  /** 読める速さ(1秒あたりの文字数)。これより速い枚は、次のテロップ・カットまでの範囲で延ばす */
  charsPerSec?: number
  /** 最短の表示時間(秒) */
  minSec?: number
}

/** 前のテロップを延ばしてつなぐ切れ目の上限(秒) */
export const TELOP_BRIDGE_SEC = 0.3

/**
 * タイムラインに置いた発言テロップの時刻を整える(画面の点滅と読み切れない枚を無くす)。
 *
 * - 次のテロップまでの切れ目が `bridgeSec` 以下なら、前のテロップを次の頭まで延ばす。
 *   0.1〜0.3 秒だけ消えてまた出ると、点滅に見える(30分の回で、最初の1枚を声の少し前に出すと
 *   この切れ目が 39 か所でき、うち 33 か所はカットの切れ目の直後だった)
 * - 文字数に対して短すぎる枚(自動の確認と同じ 1秒10文字・最短 0.5 秒)は、
 *   次のテロップの頭・カットの切れ目を越えない範囲で延ばす
 * - どちらも**カットの切れ目(`hardCuts`、タイムラインの秒)は越えない**。時間の飛んだ先の画に
 *   前の場面のテロップが残ると、言っていない言葉が画に乗る
 * - カットの切れ目の直後(`bridgeSec` 以内)に出るテロップは、切れ目から出す。画が替わってから
 *   数フレーム遅れてテロップが出ると、ちらついて見える(画とテロップを同じ瞬間に替える)
 * - 頭を前へ動かすのはこの場合だけ。重なっているテロップ(声の重なり)は延ばさない
 */
export function settleTelopTimes<T extends { text: string; startTime: number; endTime: number }>(
  telops: readonly T[],
  hardCuts: readonly number[],
  options: SettleOptions = {}
): T[] {
  const bridge = options.bridgeSec ?? TELOP_BRIDGE_SEC
  const cps = options.charsPerSec ?? READ_CHARS_PER_SEC
  const minSec = options.minSec ?? MIN_DISPLAY_SEC
  const cuts = [...hardCuts].sort((a, b) => a - b)
  const out = [...telops].sort((a, b) => a.startTime - b.startTime).map((t) => ({ ...t }))
  // 切れ目のすぐ後に出るテロップは、切れ目(画の替わる瞬間)から出す
  let prevEnd = -Infinity
  for (const t of out) {
    let cut: number | undefined
    for (const c of cuts) if (c <= t.startTime + 1e-6) cut = c
    if (cut !== undefined && t.startTime - cut <= bridge && prevEnd <= cut + 1e-6)
      t.startTime = Math.min(t.startTime, cut)
    prevEnd = Math.max(prevEnd, t.endTime)
  }
  for (let i = 0; i < out.length; i++) {
    const t = out[i]
    const cut = cuts.find((c) => c > t.startTime + 1e-6) ?? Infinity
    const next = out[i + 1]?.startTime ?? Infinity
    // 次のテロップがすでに重なっている(声の重なりで積んだ)なら延ばさない
    if (next < t.endTime - 1e-6) continue
    const limit = Math.min(cut, next)
    if (limit <= t.endTime) continue
    const chars = t.text.replace(/\s/g, '').length
    const need = Math.max(minSec, chars / cps)
    let end = t.endTime
    // 自動の確認(終わり - 頭 < 必要な長さ)に丸めの誤差で掛からないよう、ほんの少し長く
    if (end - t.startTime < need) end = Math.min(limit, t.startTime + need + 1e-6)
    if (next <= cut && next - end > 0 && next - end <= bridge) end = next
    t.endTime = end
  }
  return out
}

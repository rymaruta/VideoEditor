import type { AsrWord, TranscriptUtterance } from '@shared/transcript'
import {
  applyDictionary,
  balancedLineEnds,
  dictionaryNoCut,
  dictionaryPattern,
  FILLER,
  removeFillers,
  type DictionaryEntry
} from './polish'
import { MIN_DISPLAY_SEC, READ_CHARS_PER_SEC } from '@shared/qc/telop'

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
  /**
   * 文(空白・改行を除く)の1文字ごとの、話している時刻(素材の秒)。言葉の時刻が無い発話では無い。
   * 人が直した・消した範囲(元の発話の時刻)で、作り直した枚を切り分けるのに使う
   */
  times?: number[]
  /**
   * 出している文字を話している範囲(素材の秒。最初の文字の頭〜最後の文字の終わり。辞書で直した文字は
   * 直す前の言葉全体)。人が直した・消した範囲として覚える
   */
  spoken?: [number, number]
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

/**
 * 発話の最初の1枚を、最初の言葉の時刻より何秒まで前に出してよいか。音声認識の言葉の時刻は声より
 * 遅れる(実際の回で 0.24 秒)ので、これだけ前なら声のほんの少し前。発話の区間が声と関係のない音
 * (物音・別の人の声の回り込み)から始まると、区間の頭に合わせた枚が言葉の数秒前に出ていた(3.9 秒前)
 */
export const MAX_TELOP_LEAD_SEC = 0.4

/** 表示用に整える(句点を落とし、読点を空白に。数字の桁区切り「2,800」のカンマは残す) */
export function tidyTelopText(text: string): string {
  return text
    .replace(/、\s*|,(?!\d)\s*|(?<!\d),\s*/g, ' ')
    .replace(/[。.]+$/u, '')
    .replace(/[。]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface TimedChar {
  ch: string
  start: number
  end: number
  /** 何番目の言葉の文字か(言葉の間に足した空白は -1) */
  word: number
}

/**
 * 言葉の間を空けるか(認識した文に空白があった所だけ)。
 *
 * 音声認識は英数字の言葉を細かい片(「Mine」「craft」、「15」「000」)で返すことがあり、英数字どうしの
 * 間をいつも空けると、テロップが「Mine craft」「15 000円」になっていた。認識した文(`text`)を言葉の
 * 順に読み、文で空白を挟んでいた所だけ空ける(「Good morning」は空く)。文と言葉が合わなくなったら
 * (文を後から直した など)、そこから先は従来どおり英数字どうしの間を空ける
 */
function spacesFromText(words: readonly AsrWord[], text: string | undefined): boolean[] {
  const out: boolean[] = []
  let cursor = 0
  let aligned = typeof text === 'string' && text.length > 0
  for (const w of words) {
    const t = w.text.trim()
    if (!aligned || !text) {
      out.push(true)
      continue
    }
    let j = cursor
    while (j < text.length && /\s/.test(text[j])) j++
    if (t.length > 0 && text.startsWith(t, j)) {
      out.push(j > cursor)
      cursor = j + t.length
    } else {
      aligned = false
      out.push(true)
    }
  }
  return out
}

/**
 * 文字単位の時刻の作り置き(発話ごと)。枚ごとに発話全体を数え直すと、長い発話(8,000 語)で
 * 仮編集が 13 倍遅くなっていた(1枚ごとに発話の全文字を作り直す二乗の手間)
 */
const charTimesCache = new WeakMap<readonly AsrWord[], Map<string, TimedChar[]>>()

/** 文字単位の時刻(言葉の時刻を文字数で按分する) */
function charTimes(words: readonly AsrWord[], text?: string): TimedChar[] {
  let byText = charTimesCache.get(words)
  if (!byText) {
    byText = new Map()
    charTimesCache.set(words, byText)
  }
  const cacheKey = `${words.length}:${text ?? '\u0000'}`
  const hit = byText.get(cacheKey)
  if (hit) return hit
  const made = makeCharTimes(words, text)
  byText.set(cacheKey, made)
  return made
}

function makeCharTimes(words: readonly AsrWord[], text?: string): TimedChar[] {
  const out: TimedChar[] = []
  const spaced = spacesFromText(words, text)
  words.forEach((w, wi) => {
    // 英数字どうしの言葉の間は空ける(発話の文と同じ規則。詰めると「Helloworld」になり、言葉の途中で改行される)。
    // ただし認識した文で続いていた片(「Mine」「craft」)は詰める
    const prev = out[out.length - 1]
    if (prev && spaced[wi] && /[A-Za-z0-9]/.test(prev.ch) && /^[A-Za-z0-9]/.test(w.text))
      out.push({ ch: ' ', start: prev.end, end: prev.end, word: -1 })
    const chars = [...w.text]
    const step = chars.length > 0 ? (w.end - w.start) / chars.length : 0
    chars.forEach((ch, i) =>
      out.push({ ch, start: w.start + step * i, end: w.start + step * (i + 1), word: wi })
    )
  })
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

/** 言いよどみを除き、辞書で直し、表示用に整える */
function polishTelopText(text: string, options: ChunkOptions): string {
  let body = text
  if (options.removeFillers !== false) body = removeFillers(body)
  if (options.dictionary?.length) body = applyDictionary(body, options.dictionary)
  return tidyTelopText(body)
}

/**
 * 文字ごとに、元の発話のどの文字(番号の範囲)から来たかを持つ文。UTF-16 の1単位ごとに持つ
 * (正規表現の位置が UTF-16 の位置なので)
 */
interface Tracked {
  text: string
  span: [number, number][]
}

function tracked(chars: readonly string[], index: readonly number[]): Tracked {
  let text = ''
  const span: [number, number][] = []
  chars.forEach((c, i) => {
    text += c
    for (let k = 0; k < c.length; k++) span.push([index[i], index[i] + 1])
  })
  return { text, span }
}

/**
 * 出どころを追いながら置き換える。出どころは元の文字の位置(i 番目の文字が i〜i+1)。置き換えた文字は、
 * 置き換えられた文字の範囲を前から順に等分して持つ(辞書で「丰丳丶」を「訁訂訃訄訅」に直すと、5 文字が
 * 「丰丳丶」と言っている間を前から順に受け持つ)。置き換えた言葉が2枚に分かれても、2枚の範囲が重ならない
 * (同じ時刻にすると、両方の枚を直したとき片方の修正が消えていた)
 */
function trackedReplace(
  t: Tracked,
  re: RegExp,
  replacement: (m: RegExpMatchArray) => string
): Tracked {
  const g = re.global ? re : new RegExp(re.source, re.flags + 'g')
  g.lastIndex = 0
  let text = ''
  const span: [number, number][] = []
  let last = 0
  for (const m of t.text.matchAll(g)) {
    const at = m.index ?? 0
    if (m[0].length === 0) continue
    text += t.text.slice(last, at)
    span.push(...t.span.slice(last, at))
    const from = t.span.slice(at, at + m[0].length)
    const u: [number, number] = [
      Math.min(...from.map((x) => x[0])),
      Math.max(...from.map((x) => x[1]))
    ]
    const r = replacement(m)
    text += r
    const cps = [...r]
    cps.forEach((c, k) => {
      const a = u[0] + ((u[1] - u[0]) * k) / cps.length
      const b = u[0] + ((u[1] - u[0]) * (k + 1)) / cps.length
      for (let x = 0; x < c.length; x++) span.push([a, b])
    })
    last = at + m[0].length
  }
  text += t.text.slice(last)
  span.push(...t.span.slice(last))
  return { text, span }
}

/** `polishTelopText` と同じ整えを、文字の出どころを追いながら行う(結果の文は同じ) */
function polishTracked(t: Tracked, options: ChunkOptions): Tracked {
  let body = t
  if (options.removeFillers !== false) {
    let prev = ''
    while (body.text !== prev) {
      prev = body.text
      body = trackedReplace(body, FILLER, (m) => m[1] ?? '')
    }
    body = trackedReplace(body, /^[、,\s]+/u, () => '')
    body = trackedReplace(body, /^\s+|\s+$/gu, () => '')
  }
  const dict = options.dictionary?.length ? dictionaryPattern(options.dictionary) : null
  if (dict) body = trackedReplace(body, dict.pattern, (m) => dict.replace.get(m[0]) ?? m[0])
  body = trackedReplace(body, /、\s*|,(?!\d)\s*|(?<!\d),\s*/g, () => ' ')
  body = trackedReplace(body, /[。.]+$/u, () => '')
  body = trackedReplace(body, /[。]\s*/g, () => ' ')
  body = trackedReplace(body, /\s+/g, () => ' ')
  body = trackedReplace(body, /^\s+|\s+$/gu, () => '')
  return body
}

/** 整えた文の、空白・改行を除いた1文字ごとの、出どころの文字の頭〜終わり(素材の秒) */
/** 元の文字の位置(i 番目の文字が i〜i+1)の時刻。`end` なら、ちょうど境目の位置を前の文字の終わりとする */
function timeAtPos(timed: readonly TimedChar[], x: number, end: boolean): number {
  const n = timed.length
  let i = end ? Math.ceil(x) - 1 : Math.floor(x)
  i = Math.max(0, Math.min(n - 1, i))
  const c = timed[i]
  const f = Math.max(0, Math.min(1, x - i))
  return c.start + (c.end - c.start) * f
}

function visibleSpans(t: Tracked, timed: readonly TimedChar[]): [number, number][] {
  const out: [number, number][] = []
  let unit = 0
  for (const c of t.text) {
    if (!/\s/.test(c)) {
      const [a, b] = t.span[unit]
      out.push([timeAtPos(timed, a, false), timeAtPos(timed, b, true)])
    }
    unit += c.length
  }
  return out
}

const spokenOf = (spans: readonly [number, number][]): [number, number] | undefined =>
  spans.length > 0
    ? [Math.min(...spans.map((x) => x[0])), Math.max(...spans.map((x) => x[1]))]
    : undefined

const visibleCount = (text: string): number => [...text].filter((c) => !/\s/.test(c)).length

/**
 * 枚の一部(素材の時刻 `from`〜`to`)だけが本編に残ったときの、その部分の言葉だけの文。
 *
 * 頭・終わりがカットで落ちた枚に元の文のまま出すと、聞こえない言葉まで出る(ショートの頭が発話の途中から
 * 始まると、その枚は丸ごと捨てられて声だけが字幕なしで流れ、終わりで切れた枚は切れた言葉まで出ていた)。
 * 言葉の真ん中の時刻が残った範囲に入る言葉だけを残す(`buildSpeechOverlays` と同じく言葉の単位で)。
 * 言葉の時刻が無い発話は、元の文のまま
 */
export function clipTelopChunkText(
  u: Pick<TranscriptUtterance, 'text' | 'words'>,
  chunk: TelopChunk,
  from: number,
  to: number,
  options: ChunkOptions = {}
): string {
  return clipTelopChunk(u, chunk, from, to, options).text
}

/** `clipTelopChunkText` の文と、その1文字ごとの話している時刻(言葉の時刻が無ければ時刻なし) */
export function clipTelopChunk(
  u: Pick<TranscriptUtterance, 'text' | 'words'>,
  chunk: TelopChunk,
  from: number,
  to: number,
  options: ChunkOptions = {}
): { text: string; times?: number[]; spoken?: [number, number] } {
  if (u.words.length === 0) return { text: chunk.text }
  const timed = charTimes(u.words, u.text)
  const inside = (wi: number): boolean => {
    const w = u.words[wi]
    const mid = (w.start + w.end) / 2
    return mid >= from - 1e-6 && mid < to + 1e-6
  }
  const keep: number[] = []
  timed.forEach((c, i) => {
    if (
      c.start >= chunk.sourceStart - 1e-6 &&
      c.start < chunk.sourceEnd - 1e-6 &&
      (c.word < 0 || inside(c.word))
    )
      keep.push(i)
  })
  const polished = polishTracked(
    tracked(
      keep.map((i) => timed[i].ch),
      keep
    ),
    options
  )
  const spans = visibleSpans(polished, timed)
  return {
    text: wrapTelopLines(polished.text, options.maxLineChars ?? 14).join('\n'),
    times: spans.map(([a, b]) => (a + b) / 2),
    spoken: spokenOf(spans)
  }
}

/**
 * テロップの文の1文字ごと(空白・改行を除く)の、話している時刻(素材の秒、文字の真ん中)。
 *
 * 人が直した・消した範囲(元の発話の時刻)で、作り直した枚を切り分けるのに使う。枚の時間に文字数で
 * 割り振ると、言葉ごとの長さの違い(「は」0.7 秒と「きょう0」0.7 秒)で数文字ずれ、消していない言葉まで
 * 消えていた。整えた文(言いよどみを除く・辞書で直す)の文字を、元の言葉の文字に前から順に合わせる
 * (合わない文字 = 辞書で直した文字は、直前に合った所の時刻)。`from`〜`to` は、頭・終わりを
 * カットで落とした枚の残った範囲(`clipTelopChunkText` と同じ言葉を見る)。
 * 言葉の時刻が無い発話は null
 */
export function telopCharTimes(
  u: Pick<TranscriptUtterance, 'text' | 'words'>,
  chunk: TelopChunk,
  text: string,
  from = -Infinity,
  to = Infinity,
  options: ChunkOptions = {}
): number[] | null {
  if (u.words.length === 0) return null
  const n = visibleCount(text)
  if (from === -Infinity && to === Infinity && chunk.times?.length === n) return chunk.times
  const clipped = clipTelopChunk(u, chunk, from, to, options)
  if (clipped.times?.length === n) return clipped.times
  // 文が合わない(手で作った枚など): 前から順に同じ文字へ合わせる(見つからない文字は直前の時刻)
  const timed = charTimes(u.words, u.text).filter(
    (c) => c.word >= 0 && c.start >= chunk.sourceStart - 1e-6 && c.start < chunk.sourceEnd - 1e-6
  )
  if (timed.length === 0) return null
  const out: number[] = []
  let j = 0
  for (const ch of [...text]) {
    if (/\s/.test(ch)) continue
    let k = -1
    for (let x = j; x < timed.length; x++)
      if (timed[x].ch === ch) {
        k = x
        break
      }
    const at = k >= 0 ? k : Math.min(j, timed.length - 1)
    out.push((timed[at].start + timed[at].end) / 2)
    if (k >= 0) j = k + 1
  }
  return out
}

export function utteranceToTelopChunks(
  u: Pick<TranscriptUtterance, 'text' | 'words' | 'sourceStart' | 'sourceEnd'>,
  options: ChunkOptions = {}
): TelopChunk[] {
  const maxLine = options.maxLineChars ?? 14
  const maxLines = options.maxLines ?? 2
  const minDur = options.minDurationSec ?? 1.0

  const timed = u.words.length > 0 ? charTimes(u.words, u.text) : []
  const raw = timed.length > 0 ? timed.map((c) => c.ch).join('') : u.text
  const chars = [...raw]
  // 1枚の長さを揃えて区切ってから、1枚ずつ改行する。前から1枚ずつ上限まで詰めると、最後の1枚が
  // 数文字だけになり(「ある」だけが 1.8秒出る)、詰めた1枚は禁則の位置しだいで3行になる。
  // 1枚の上限は 行数×1行 より少し短くし、改行の位置を選ぶ余地を残す(余地が無いと3行になる)
  const sheetMax = Math.max(maxLine, maxLine * maxLines - Math.ceil(maxLine / 8))
  const ends = balancedLineEnds(chars, sheetMax, dictionaryNoCut(chars, options.dictionary))
  const pieces = ends.map((end, i) => ({ from: i === 0 ? 0 : ends[i - 1], to: end }))

  const polish = (text: string): string => polishTelopText(text, options)
  // 言葉の時刻が無いときは、発話の時間を文字数で割り振る(全部の枚を発話の頭からにすると、
  // 重ならないように詰めた結果、最後の1枚以外が長さ 0 になる)
  const timeAt = (i: number): number =>
    u.sourceStart + ((u.sourceEnd - u.sourceStart) * i) / Math.max(1, chars.length)
  const chunks: TelopChunk[] = []
  for (const p of pieces) {
    // 言いよどみを除く・辞書で直すと長さが変わるので、整えた文で改行し直す
    const polished = polish(chars.slice(p.from, p.to).join(''))
    // 1文字ごとの話している時刻(整えた文の文字が、元のどの文字から来たかを追って決める)
    const spans =
      timed.length > 0
        ? visibleSpans(
            polishTracked(
              tracked(
                chars.slice(p.from, p.to),
                chars.slice(p.from, p.to).map((_, i) => p.from + i)
              ),
              options
            ),
            timed
          )
        : null
    const times = spans ? spans.map(([a, b]) => (a + b) / 2) : null
    const lines = wrapTelopLines(polished, maxLine)
    const text = lines.join('\n')
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
      start = Math.max(
        u.sourceStart,
        start - MAX_TELOP_LEAD_SEC,
        Math.min(start, u.sourceStart + FIRST_TELOP_DELAY_SEC)
      )
    const end = timed.length > 0 ? timed[to - 1].end : timeAt(to)
    // 辞書で長い言葉に直すと、区切ったときより文字が増えて行数を超えることがある。
    // 行数に収まる枚に分け、時間は文字数で割り振る
    const sheets: string[][] = []
    for (let k = 0; k < lines.length; k += maxLines) sheets.push(lines.slice(k, k + maxLines))
    const total = lines.reduce((t, l) => t + [...l].length, 0)
    let done = 0
    let shown = 0
    for (const sheet of sheets) {
      const len = sheet.reduce((t, l) => t + [...l].length, 0)
      const a = start + ((end - start) * done) / Math.max(1, total)
      done += len
      const b = start + ((end - start) * done) / Math.max(1, total)
      const sheetText = sheet.join('\n')
      const n = visibleCount(sheetText)
      const ok = times !== null && times.length === visibleCount(text)
      const sheetTimes = ok ? times.slice(shown, shown + n) : undefined
      const sheetSpoken = ok && spans ? spokenOf(spans.slice(shown, shown + n)) : undefined
      shown += n
      chunks.push({
        text: sheetText,
        sourceStart: a,
        sourceEnd: Math.max(b, a + minDur),
        ...(sheetTimes ? { times: sheetTimes } : {}),
        ...(sheetSpoken ? { spoken: sheetSpoken } : {})
      })
    }
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

import type { AsrWord, TranscriptUtterance } from '../transcript'
import {
  applyDictionary,
  balancedLineEnds,
  dictionaryNoCut,
  dictionaryPattern,
  FILLER,
  removeFillers,
  type DictionaryEntry
} from './polish'
import { MIN_DISPLAY_SEC, READ_CHARS_PER_SEC } from '../qc/telop'
import { AUTO_SOURCE_MARGIN } from './manual'

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
  /**
   * 枚の元の部分の範囲(素材の秒。`spoken` ± 人の修正の範囲の余裕を、前後の枚の文字の時刻の手前までに
   * 縮めたもの)。人が直した・消した範囲として覚える
   */
  range?: [number, number]
  /**
   * 文字ごとの話している長さ(秒、1/1000 に丸める。頭〜終わり = 時刻 ∓ 長さ/2)。切り分けた枚の時刻を
   * 声に合わせるのに使う(隣の文字との間隔から決めると、伸ばした語尾「ね」の枚が声より早く消えていた)
   */
  durs?: number[]
  /**
   * 言いよどみの言葉(「えっと、」)が枚の境目で分かれて残った切れ端の文字(何文字目か)。人の修正が
   * この切れ端だけに当たるときは修正を出さない(言いよどみの言葉そのものでない「そう」「うん」は含まない)
   */
  fill?: number[]
  /** 元の文字の範囲と、その整えた文の何文字目から何文字がこの枚か(カットで頭・終わりを落とすのに使う) */
  piece?: { from: number; to: number; skip: number; count: number }
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

/** 長さ 0 の言葉の文字の間隔の上限(秒) */
const ZERO_WORD_CHAR_SEC = 0.01

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
    const step = chars.length > 0 ? Math.max(0, w.end - w.start) / chars.length : 0
    chars.forEach((ch, i) =>
      out.push({ ch, start: w.start + step * i, end: w.start + step * (i + 1), word: wi })
    )
  })
  spreadZeroWords(out, words)
  return out
}

/**
 * 長さ 0 の言葉(Whisper の語の時刻は 0.02 秒刻みで、長さ 0 がよく出る)の文字を、前後の言葉の間に少しずつ
 * (最大 0.01 秒)並べる。同じ時刻にすると、枚の境目で分かれた言葉の文字を時刻で見分けられず、隣の枚を
 * 直した・消した範囲に入っていた。長さのある言葉の時刻は動かさない(次の言葉をずらすと、ずれが積もって
 * 次の言葉の枚が声より 0.16 秒遅れ、カットの後ろへ聞こえない言葉が出ていた)。
 * 言葉の時刻より後ろ(次の言葉の手前まで。人の修正の範囲の余裕 ×2 を空ける)に詰めて並べ、後ろに余地が
 * 無ければ前の言葉との間へ、それも無ければ前の言葉の最後の文字と次の言葉の最初の文字の真ん中どうしの間に
 * 詰める(0.006 秒より詰めてもよい)。文字の話している時刻(真ん中)はいつも増える順
 */
function spreadZeroWords(out: TimedChar[], words: readonly AsrWord[]): void {
  const zero = (c: TimedChar): boolean =>
    c.word < 0 || (words[c.word].end - words[c.word].start <= 1e-6 && words[c.word].text !== '')
  for (let i = 0; i < out.length;) {
    if (!zero(out[i]) || out[i].word < 0) {
      i++
      continue
    }
    let j = i
    while (j < out.length && zero(out[j])) j++
    // out[i..j) が続く長さ 0 の言葉の文字(間の空白を含む)
    const prev = i > 0 ? out[i - 1] : null
    const next = j < out.length ? out[j] : null
    const n = j - i
    const gap = 2 * AUTO_SOURCE_MARGIN
    const g0 = prev ? prev.end + gap : -Infinity
    const g1 = next ? next.start - gap : Infinity
    let lo: number
    let hi: number
    let step: number
    const ahead = g1 - Math.max(out[i].start, g0)
    if (ahead >= n * 0.001) {
      // 言葉の時刻より後ろ(次の言葉の手前まで)に並べる。前へ並べると、言葉の直前のカットの前に文字が入り、
      // 聞こえない言葉の文字が出ていた
      step = Math.min(ZERO_WORD_CHAR_SEC, ahead / n)
      lo = Math.max(out[i].start, g0)
      hi = g1
    } else if (g1 - g0 >= n * 0.001) {
      // 後ろに余地が無ければ、前の言葉との間へ
      step = Math.min(ZERO_WORD_CHAR_SEC, (g1 - g0) / n)
      lo = g0
      hi = g1
    } else {
      // 前後の言葉の間が無い: 隣の2文字の真ん中どうしの間に詰める(隣の文字の時刻は動かさない。枚の範囲は
      // 前後の枚の文字の時刻の手前までに縮めるので、隣の枚に取られない)
      const l = prev ? (prev.start + prev.end) / 2 : out[i].start - ZERO_WORD_CHAR_SEC * (n + 1)
      const r = next ? (next.start + next.end) / 2 : out[i].start + ZERO_WORD_CHAR_SEC * (n + 1)
      step = Math.min(ZERO_WORD_CHAR_SEC, Math.max(0, r - l) / (n + 1))
      lo = l + step / 2
      hi = r - step / 2
    }
    // 言葉ごとに、その言葉の時刻からなるべく近く(前の言葉の文字の後ろ、残りの文字が入る所まで)
    let cursor = lo
    for (let k = i; k < j; k++) {
      const wordStart = k === i || out[k].word !== out[k - 1].word ? out[k].start : null
      const at = Math.min(Math.max(wordStart ?? cursor, cursor), hi - step * (j - k))
      out[k].start = at
      out[k].end = at + step
      cursor = at + step
    }
    i = j
  }
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
  /** 辞書で直した文字か(言いよどみの切れ端とみなさない) */
  run: boolean[]
}

function tracked(chars: readonly string[], index: readonly number[]): Tracked {
  let text = ''
  const span: [number, number][] = []
  const run: boolean[] = []
  chars.forEach((c, i) => {
    text += c
    for (let k = 0; k < c.length; k++) {
      span.push([index[i], index[i] + 1])
      run.push(false)
    }
  })
  return { text, span, run }
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
  replacement: (m: RegExpMatchArray) => string,
  /** 辞書で直す置き換え(直した言葉として印を付ける) */
  markRun = false
): Tracked {
  const g = re.global ? re : new RegExp(re.source, re.flags + 'g')
  g.lastIndex = 0
  let text = ''
  const span: [number, number][] = []
  const run: boolean[] = []
  let last = 0
  for (const m of t.text.matchAll(g)) {
    const at = m.index ?? 0
    if (m[0].length === 0) continue
    text += t.text.slice(last, at)
    span.push(...t.span.slice(last, at))
    run.push(...t.run.slice(last, at))
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
      for (let x = 0; x < c.length; x++) {
        span.push([a, b])
        run.push(markRun)
      }
    })
    last = at + m[0].length
  }
  text += t.text.slice(last)
  span.push(...t.span.slice(last))
  run.push(...t.run.slice(last))
  return { text, span, run }
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
  if (dict) body = trackedReplace(body, dict.pattern, (m) => dict.replace.get(m[0]) ?? m[0], true)
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

interface VisibleChar {
  /** 話している頭〜終わり(素材の秒。辞書で直した文字は、直す前の言葉を前から順に等分した分) */
  lo: number
  hi: number
  /** 出どころの元の文字の位置(i 番目の文字が i〜i+1) */
  a: number
  b: number
  /** 何番目の言葉の文字か */
  word: number
  /** 言いよどみの言葉(まるごとなら整えると消える言葉)の文字か */
  fill: boolean
}

function visibleInfo(
  t: Tracked,
  timed: readonly TimedChar[],
  fillerWord: (word: number) => boolean = () => false
): VisibleChar[] {
  const out: VisibleChar[] = []
  const n = timed.length
  const wordAt = (x: number): number => {
    let i = Math.max(0, Math.min(n - 1, Math.floor(x)))
    while (i > 0 && timed[i].word < 0) i--
    return timed[i].word
  }
  let unit = 0
  for (const c of t.text) {
    if (!/\s/.test(c)) {
      const [a, b] = t.span[unit]
      out.push({
        lo: timeAtPos(timed, a, false),
        hi: timeAtPos(timed, b, true),
        a,
        b,
        word: wordAt((a + b) / 2),
        fill: !t.run[unit] && fillerWord(wordAt((a + b) / 2))
      })
    }
    unit += c.length
  }
  return out
}

/** 言いよどみの言葉(まるごとなら整えると消える言葉)か。言葉ごと */
const fillerCache = new WeakMap<readonly AsrWord[], boolean[]>()
function fillerWords(words: readonly AsrWord[]): (word: number) => boolean {
  let flags = fillerCache.get(words)
  if (!flags) {
    flags = words.map((w) => w.text.trim() !== '' && removeFillers(w.text) === '')
    fillerCache.set(words, flags)
  }
  const f = flags
  return (i) => f[i] === true
}

/** 文字ごとの話している長さ・言いよどみの切れ端(`TelopChunk.durs`・`fill`) */
function extrasOf(vis: readonly VisibleChar[]): { durs: number[]; fill?: number[] } {
  const fill = vis.map((v, i) => (v.fill ? i : -1)).filter((i) => i >= 0)
  return {
    durs: vis.map((v) => Math.round(Math.max(0, v.hi - v.lo) * 1000) / 1000),
    ...(fill.length > 0 ? { fill } : {})
  }
}

const spokenOf = (vis: readonly VisibleChar[]): [number, number] | undefined =>
  vis.length > 0
    ? [Math.min(...vis.map((x) => x.lo)), Math.max(...vis.map((x) => x.hi))]
    : undefined

/**
 * 枚の元の部分の範囲(話している時刻 ± 人の修正の範囲の余裕)。この枚に無い前後の文字の話している時刻
 * (真ん中)は含めない(余裕を前後の文字との真ん中までに縮める)。長さ 0 の言葉の文字は詰めて並べるので、
 * 余裕だけ広げると枚の境目で分かれた言葉の隣の枚の文字まで範囲に入り、この枚を消すとその文字まで消えた。
 *
 * 縮めるのは、この枚の文字の話している範囲(頭〜終わり)の外だけ。辞書で直した文字は直す前の言葉全体を
 * 受け持つので、文字の真ん中(「あいうえお」→「X」の 1.25 秒)から測って縮めると、元の言葉の頭の「あ」が
 * 範囲から外れ、辞書を外して作り直すと直した・消した枚の隣に「あ」が出ていた。
 * 前後の文字は、元の文字の並びの前後の文字と、同じ元の部分から分けた隣の枚の文字(`before`・`after`)。
 * 元の文字の並びだけを見ると、辞書で長くして2枚に分けた言葉の隣の枚の文字(同じ元の言葉から作った
 * 「ブ」「チ」)を見ずに範囲に入れ、片方の枚を消すともう片方の頭・終わりの文字まで消えていた
 */
function rangeOf(
  vis: readonly VisibleChar[],
  timed: readonly TimedChar[],
  before?: VisibleChar,
  after?: VisibleChar
): [number, number] | undefined {
  const sp = spokenOf(vis)
  if (!sp) return undefined
  const center = (c: { start: number; end: number }): number => (c.start + c.end) / 2
  const mid = (v: VisibleChar): number => (v.lo + v.hi) / 2
  const times = vis.map(mid)
  const first = Math.min(...times)
  const last = Math.max(...times)
  const prev: number[] = before ? [mid(before)] : []
  const next: number[] = after ? [mid(after)] : []
  let i = Math.floor(Math.min(...vis.map((v) => v.a))) - 1
  while (i >= 0 && (timed[i].word < 0 || /\s/.test(timed[i].ch))) i--
  if (i >= 0) prev.push(center(timed[i]))
  let j = Math.ceil(Math.max(...vis.map((v) => v.b)))
  while (j < timed.length && (timed[j].word < 0 || /\s/.test(timed[j].ch))) j++
  if (j < timed.length) next.push(center(timed[j]))
  let start = Math.max(0, sp[0] - AUTO_SOURCE_MARGIN)
  let end = sp[1] + AUTO_SOURCE_MARGIN
  // 前後の文字がこの枚の話している範囲の外なら範囲の端との真ん中まで、範囲に食い込んでいれば(言葉の
  // 時刻が重なる)この枚の文字の真ん中との真ん中まで
  for (const c of prev)
    if (c < first) start = Math.max(start, (c + (c < sp[0] ? sp[0] : first)) / 2)
  for (const c of next) if (c > last) end = Math.min(end, (c + (c > sp[1] ? sp[1] : last)) / 2)
  // 消した印の鍵は範囲を 1/1000 秒に丸めて覚える(`autoTelopKey`)。丸めで隣の文字の時刻を越えるなら、
  // この枚の文字の時刻を含むかぎり内側の 1/1000 秒に寄せる(辞書で長くした長さ 0 の言葉の文字は 0.0015 秒
  // おきに並び、前の枚を消すと丸めた範囲に後ろの枚の頭の「チ」が入って消えていた)
  const label = (t: number): number => Number(Math.max(0, t).toFixed(3))
  const before0 = Math.max(...prev.filter((c) => c < first))
  const after0 = Math.min(...next.filter((c) => c > last))
  if (label(start) <= before0 + 1e-9) {
    const s = Math.ceil(start * 1000 - 1e-6) / 1000
    if (s > before0 + 1e-9 && s <= first) start = s
  }
  if (label(end) >= after0 - 1e-9) {
    const e = Math.floor(end * 1000 + 1e-6) / 1000
    if (e < after0 - 1e-9 && e >= last) end = e
  }
  return [start, end]
}

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

/** 元の文字の範囲を整えた文が、そっくり1枚に収まっているか(何枚かに分けていない) */
function isWholePiece(
  u: Pick<TranscriptUtterance, 'text' | 'words'>,
  piece: NonNullable<TelopChunk['piece']>,
  options: ChunkOptions
): boolean {
  const timed = charTimes(u.words, u.text)
  const raw = timed
    .slice(piece.from, piece.to)
    .map((c) => c.ch)
    .join('')
  return visibleCount(polishTelopText(raw, options)) === piece.count
}

/** `clipTelopChunkText` の文と、その1文字ごとの話している時刻(言葉の時刻が無ければ時刻なし) */
export function clipTelopChunk(
  u: Pick<TranscriptUtterance, 'text' | 'words'>,
  chunk: TelopChunk,
  from: number,
  to: number,
  options: ChunkOptions = {}
): {
  text: string
  times?: number[]
  spoken?: [number, number]
  range?: [number, number]
  durs?: number[]
  fill?: number[]
} {
  if (u.words.length === 0) return { text: chunk.text }
  const timed = charTimes(u.words, u.text)
  const inside = (wi: number): boolean => {
    const w = u.words[wi]
    if (!w) return false
    const mid = (w.start + w.end) / 2
    return mid >= from - 1e-6 && mid < to + 1e-6
  }
  const finish = (
    text: string,
    vis: VisibleChar[],
    before?: VisibleChar,
    after?: VisibleChar
  ): ReturnType<typeof clipTelopChunk> => ({
    text: wrapTelopLines(text, options.maxLineChars ?? 14).join('\n'),
    times: vis.map((v) => (v.lo + v.hi) / 2),
    spoken: spokenOf(vis),
    range: rangeOf(vis, timed, before, after),
    ...extrasOf(vis)
  })
  // 1枚に収まった枚は、これまでどおり枚の時刻の中の元の文字を選んで整え直す(文は前と同じ)。
  // 辞書で長くなって何枚かに分けた枚だけ、その枚の文字そのものから選ぶ
  const piece = chunk.piece
  const sheeted = piece !== undefined && !(piece.skip === 0 && isWholePiece(u, piece, options))
  if (piece && sheeted) {
    // この枚の文字そのもの(整えた文の何文字目からか)から、残った範囲で話している言葉の文字を選ぶ。
    // 時刻の窓(枚の頭〜終わり)で元の文字を選ぶと、辞書で長くなって何枚かに分けた枚では窓が文字数で
    // 割り振った時刻なので、同じ言葉が2枚に出たり、残った範囲で話している言葉が消えたりしていた
    const { from: pf, to: pt, skip, count } = piece
    const idx = Array.from({ length: pt - pf }, (_, i) => pf + i)
    const polished = polishTracked(
      tracked(
        idx.map((i) => timed[i].ch),
        idx
      ),
      options
    )
    const all = visibleInfo(polished, timed, fillerWords(u.words))
    const keepVis = all.map((v, i) => i >= skip && i < skip + count && inside(v.word))
    let text = ''
    let k = 0
    for (const c of polished.text) {
      if (/\s/.test(c)) text += c
      else {
        if (keepVis[k]) text += c
        k++
      }
    }
    const firstKept = keepVis.indexOf(true)
    const lastKept = keepVis.lastIndexOf(true)
    return finish(
      text.replace(/\s+/g, ' ').trim(),
      all.filter((_, i) => keepVis[i]),
      all[firstKept - 1],
      lastKept >= 0 ? all[lastKept + 1] : undefined
    )
  }
  // 枚の元の文字(何文字目から何文字目まで)から選ぶ。時刻の窓で選ぶと、音声認識の言葉の時刻が重なる
  // (「今日は」の終わりより「配信」の頭が早い)と前の枚の文字が入って同じ言葉が2枚に出て、同じ時刻の
  // 長さ 0 の言葉「丰」「ね」が2枚に分かれると、枚の頭・終わりを言葉の時刻にそろえて詰めた窓から「丰」が
  // 外れて消えていた。元の文字の範囲が無い枚(言葉の時刻が無い)は時刻の窓で
  const keep: number[] = []
  timed.forEach((c, i) => {
    const mine = piece
      ? i >= piece.from && i < piece.to
      : c.start >= chunk.sourceStart - 1e-6 && c.start < chunk.sourceEnd - 1e-6
    if (mine && (c.word < 0 || inside(c.word))) keep.push(i)
  })
  const polished = polishTracked(
    tracked(
      keep.map((i) => timed[i].ch),
      keep
    ),
    options
  )
  return finish(polished.text, visibleInfo(polished, timed, fillerWords(u.words)))
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
  /** 辞書で長くして何枚かに分けた枚の並び([最初の枚, 最後の枚の次]) */
  const groups: [number, number][] = []
  for (const p of pieces) {
    // 言いよどみを除く・辞書で直すと長さが変わるので、整えた文で改行し直す
    const polished = polish(chars.slice(p.from, p.to).join(''))
    // 1文字ごとの話している時刻(整えた文の文字が、元のどの文字から来たかを追って決める)
    const vis =
      timed.length > 0
        ? visibleInfo(
            polishTracked(
              tracked(
                chars.slice(p.from, p.to),
                chars.slice(p.from, p.to).map((_, i) => p.from + i)
              ),
              options
            ),
            timed,
            fillerWords(u.words)
          )
        : null
    const times = vis ? vis.map((v) => (v.lo + v.hi) / 2) : null
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
    // 長さ 0 の言葉の文字は言葉の時刻の前後へ並べるので、枚の頭・終わりは言葉の時刻も含める(頭をカットで
    // 落としたかをこれで決める。並べた文字の時刻で決めると、カットの直前の言葉がカットの後ろへ並んで頭を
    // 落としていないとみなされ、聞こえない「七丄」が出ていた)
    const zeroWord = (i: number): AsrWord | undefined => {
      const w = u.words[timed[i].word]
      return w && w.end - w.start <= 1e-6 ? w : undefined
    }
    // 枚の境目で分かれた言葉は、文字の時刻のまま(言葉の時刻にすると前の枚の終わりが詰められ、その枚の
    // 文字が枚の時刻の外に出て選ばれなかった)
    const wordStart = (i: number): number =>
      i > 0 && timed[i - 1].word === timed[i].word
        ? timed[i].start
        : (zeroWord(i)?.start ?? timed[i].start)
    const wordEnd = (i: number): number =>
      i + 1 < timed.length && timed[i + 1].word === timed[i].word
        ? timed[i].end
        : (zeroWord(i)?.end ?? timed[i].end)
    let start = timed.length > 0 ? Math.min(timed[from].start, wordStart(from)) : timeAt(from)
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
    const end = timed.length > 0 ? Math.max(timed[to - 1].end, wordEnd(to - 1)) : timeAt(to)
    // 辞書で長い言葉に直すと、区切ったときより文字が増えて行数を超えることがある。行数に収まる枚に分け、
    // 時間はそれぞれの枚の文字を話している時刻から決める(文字数で割り振ると、2.5 秒遅れて出る枚・
    // 声より早く消える枚があった)。言葉の時刻が無ければ文字数で割り振る
    const sheets: string[][] = []
    for (let k = 0; k < lines.length; k += maxLines) sheets.push(lines.slice(k, k + maxLines))
    const total = lines.reduce((t, l) => t + [...l].length, 0)
    const ok = vis !== null && times !== null && times.length === visibleCount(text)
    let done = 0
    let shown = 0
    const base = chunks.length
    sheets.forEach((sheet, si) => {
      const len = sheet.reduce((t, l) => t + [...l].length, 0)
      const sheetText = sheet.join('\n')
      const n = visibleCount(sheetText)
      const mine = ok ? vis.slice(shown, shown + n) : null
      const sheetSpoken = mine ? spokenOf(mine) : undefined
      let a = start + ((end - start) * done) / Math.max(1, total)
      done += len
      let b = start + ((end - start) * done) / Math.max(1, total)
      if (sheets.length > 1 && sheetSpoken) {
        a = si === 0 ? start : Math.max(start, sheetSpoken[0])
        b = si === sheets.length - 1 ? end : Math.max(a, sheetSpoken[1])
      }
      const sheetRange = mine ? rangeOf(mine, timed, vis?.[shown - 1], vis?.[shown + n]) : undefined
      chunks.push({
        text: sheetText,
        sourceStart: a,
        sourceEnd: Math.max(b, a + minDur),
        ...(mine ? { times: mine.map((v) => (v.lo + v.hi) / 2), ...extrasOf(mine) } : {}),
        ...(sheetSpoken ? { spoken: sheetSpoken } : {}),
        ...(sheetRange ? { range: sheetRange } : {}),
        ...(ok ? { piece: { from: p.from, to: p.to, skip: shown, count: n } } : {})
      })
      shown += n
    })
    if (chunks.length - base > 1) groups.push([base, chunks.length])
  }
  spaceSheets(chunks, groups, minDur)
  // 次のテロップに重ならないように(最低表示時間で伸ばした分を詰める)
  for (let k = 0; k < chunks.length - 1; k++) {
    chunks[k].sourceEnd = Math.min(chunks[k].sourceEnd, chunks[k + 1].sourceStart)
  }
  return chunks
}

/** 辞書で長くして分けた枚を、少なくともこれだけ出す(秒。仮編集はこれより短い枚を捨てる) */
const MIN_SHEET_SEC = 0.35
/** 声のある枚の頭を動かしてよい長さ(秒。声より遅れて出すぎない・前の枚が声より早く消えすぎない) */
const SHEET_SHIFT_SEC = 0.1

/**
 * 辞書で長くして何枚かに分けた枚の頭を、どの枚も `MIN_SHEET_SEC` は出るように空ける。枚の時刻はその枚の
 * 文字を話している時刻から決めるので、長さ 0 の言葉を長くして3枚に分けると、真ん中の枚が 0.01 秒ほどしか
 * 無く、仮編集で捨てられてその言葉が一度も出なかった。
 * 足りない枚があるときだけ、後ろの枚の頭を早め、それでも足りなければ遅らせる(分けた枚に続く枚の頭も)。
 * 声のある枚の頭は `SHEET_SHIFT_SEC` まで(遅らせると声に遅れ、早めると前の枚が声より早く消える)。
 * 声の無い(長さ 0 の言葉だけの)枚の頭は、分けた最初の枚の頭より後ろで動かす。それでも入りきらない
 * (声のある枚に挟まれて間が狭すぎる)ときは、入るだけ空ける
 */
function spaceSheets(
  chunks: TelopChunk[],
  groups: readonly [number, number][],
  minDur: number
): void {
  const voiced = (c: TelopChunk | undefined): boolean =>
    !!c?.spoken && c.spoken[1] - c.spoken[0] > 0.05
  for (const [g0, g1] of groups) {
    const k = g1 - g0
    // 枚の頭(k 番目は続く枚の頭。無ければ動かさない)
    const a = Array.from({ length: k + 1 }, (_, s) => chunks[g0 + s]?.sourceStart ?? Infinity)
    if (a.slice(1).every((x, s) => x - a[s] >= MIN_SHEET_SEC)) continue
    const lo = (s: number): number =>
      Math.max(a[0], voiced(chunks[g0 + s - 1]) ? a[s] - SHEET_SHIFT_SEC : -Infinity)
    const hi = (s: number): number =>
      g0 + s >= chunks.length ? a[s] : voiced(chunks[g0 + s]) ? a[s] + SHEET_SHIFT_SEC : Infinity
    const b = [...a]
    for (let s = k - 1; s >= 1; s--)
      b[s] = Math.max(lo(s), Math.min(a[s], b[s + 1] - MIN_SHEET_SEC))
    for (let s = 1; s <= k; s++) b[s] = Math.min(hi(s), Math.max(b[s], b[s - 1] + MIN_SHEET_SEC))
    // 足りないまま(間が狭い)なら、後ろから詰め直して頭の順を保つ
    for (let s = k - 1; s >= 1; s--)
      b[s] = Math.max(lo(s), Math.min(b[s], b[s + 1] - MIN_SHEET_SEC))
    for (let s = 1; s <= k; s++) b[s] = Math.max(b[s], b[s - 1])
    for (let s = 1; s <= k && g0 + s < chunks.length; s++) {
      const c = chunks[g0 + s]
      c.sourceStart = b[s]
      c.sourceEnd = Math.max(c.sourceEnd, b[s] + minDur)
    }
  }
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

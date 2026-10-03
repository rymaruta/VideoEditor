/**
 * 発言テロップの文の整え(計画書 §5.8)。
 *
 * - 言いよどみ(えー・あのー・えっと 等)を除く。**発言の頭か、区切り(読点・空白)の後に、
 *   区切りを伴って出てくるものだけ**を消す。文中の意味のある「あの」(あの人)・「まあまあ」は残す
 * - 用語の辞書(聞き違い・出演者名・地名の表記)で直す。辞書は利用者が登録したものだけを使う
 * - 改行は、行頭禁則(句読点・小さい仮名・長音・閉じ括弧を行頭に置かない)を守り、
 *   句読点の後 > 助詞の後 > 仮名と漢字の境目 の順に区切りやすくする
 *
 * 言い換え・要約はしない(言葉を作らない)。
 */

const FILLER =
  /(^|[、,。\s])(?:え[ーぇ]+と|えっと|え[ーぇ]*っと|え[ーぇ]+(?=[、,\s])|あの[ーぉ]+|そ[のー]ー+|ま[あー]+(?=[、,\s])|う[ーん]+(?=[、,\s])|ん[ーっ]+(?=[、,\s])|あ[ーぁ]+(?=[、,\s]))[、,\s]*/gu

export function removeFillers(text: string): string {
  let prev = ''
  let out = text
  // 「えー、あのー、」のように続くものもあるので、変わらなくなるまで繰り返す
  while (out !== prev) {
    prev = out
    out = out.replace(FILLER, '$1')
  }
  return out.replace(/^[、,\s]+/u, '').trim()
}

export interface DictionaryEntry {
  from: string
  to: string
}

/** 登録された置き換えを、長いものから順に当てる(短いものが長いものの一部を先に壊さないように) */
export function applyDictionary(text: string, entries: readonly DictionaryEntry[]): string {
  const sorted = [...entries].filter((e) => e.from).sort((a, b) => b.from.length - a.from.length)
  let out = text
  for (const e of sorted) out = out.split(e.from).join(e.to)
  return out
}

/** 「誤 → 正」の行を読み込む(→ / => / タブ区切り。空行・# の行は飛ばす) */
export function parseDictionary(text: string): DictionaryEntry[] {
  const out: DictionaryEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(.+?)\s*(?:→|=>|\t)\s*(.*)$/u.exec(line)
    if (m && m[1].trim()) out.push({ from: m[1].trim(), to: m[2].trim() })
  }
  return out
}

/** 行頭に置かない文字 */
const NO_LINE_START =
  /[、。,.!?！？)）」』】ゝゞーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ・…]/u
/** 行末に置かない文字 */
const NO_LINE_END = /[(（「『【]/u
const PUNCT = /[、。！？!?,.\s]/u
const PARTICLE = /[はがをにでともへやのね]/u
const KANA = /[぀-ヿ]/u
const KANJI = /[一-鿿々]/u

/**
 * k 文字目の手前で区切る良さ(大きいほど良い)。区切れない所は -Infinity。
 * chars[k-1] が行末、chars[k] が次の行頭になる。
 */
export function breakScore(chars: readonly string[], k: number): number {
  if (k <= 0 || k >= chars.length) return -Infinity
  const prev = chars[k - 1]
  const next = chars[k]
  if (NO_LINE_START.test(next) || NO_LINE_END.test(prev)) return -Infinity
  if (PUNCT.test(prev)) return 3
  if (PARTICLE.test(prev) && !PARTICLE.test(next) && KANA.test(prev)) return 2
  if (KANA.test(prev) && KANJI.test(next)) return 1
  return 0
}

/**
 * 長さ `max` 以内で、良い区切りを探す。後ろ半分の中から点数の高い所(同点なら後ろ)を選ぶ。
 * どこも区切れなければ、禁則の文字を1つだけ前の行にぶら下げる。
 */
export function findBreak(chars: readonly string[], from: number, max: number): number {
  const limit = Math.min(chars.length, from + max)
  if (limit >= chars.length) return chars.length
  let best = -1
  let bestScore = -Infinity
  for (let k = limit; k > from + Math.floor(max / 2); k--) {
    const sc = breakScore(chars, k)
    if (sc > bestScore) {
      best = k
      bestScore = sc
    }
  }
  if (best > 0 && bestScore > -Infinity) return best
  // ぶら下げ: 次の行頭が禁則なら、その文字まで前の行に入れる
  let k = limit
  while (k < chars.length && NO_LINE_START.test(chars[k])) k++
  return k
}

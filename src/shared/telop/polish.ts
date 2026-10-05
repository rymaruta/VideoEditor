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
/** 前の文字とくっついて1文字になるもの */
const JOINS_PREVIOUS =
  /^(?:\u200d|[\ufe00-\ufe0f]|[\u{1f3fb}-\u{1f3ff}]|[\u{e0020}-\u{e007f}]|\p{M})/u

export function breakScore(chars: readonly string[], k: number): number {
  if (k <= 0 || k >= chars.length) return -Infinity
  const prev = chars[k - 1]
  const next = chars[k]
  // 絵文字の組み合わせ(ZWJ・肌の色・異体字セレクタ)・後ろに付けた濁点の途中では切らない
  if (JOINS_PREVIOUS.test(next) || prev === '\u200d') return -Infinity
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
  // ぶら下げ: 次の行頭が禁則なら、その1文字だけ前の行に入れる。
  // 禁則の文字が続く(「すごーーーー…い」)ときは、ぶら下げ続けると1行が際限なく長くなり
  // 画面からはみ出すので、禁則を破って上限の位置で切る
  if (NO_LINE_START.test(chars[limit])) {
    const k = limit + 1
    if (k >= chars.length || !NO_LINE_START.test(chars[k])) return k
  }
  return limit
}

/**
 * 行の区切りを、**長さを揃えて**決める(終わりの位置の並び)。
 * 前から1行ずつ上限まで詰めると、最後の行に数文字だけ残る(「…パック牛乳で / ある」)。
 * 残りを何行で書くかを先に決め、その平均の長さの近くで良い区切りを探す。
 * 各行は `maxLine` 以内(区切れる所が無いときの禁則のぶら下げで、1文字だけ超えうる)。
 */
export function balancedLineEnds(chars: readonly string[], maxLine: number): number[] {
  const ends: number[] = []
  const max = Math.max(1, Math.floor(maxLine))
  let from = 0
  while (from < chars.length) {
    const remaining = chars.length - from
    if (remaining <= max) {
      ends.push(chars.length)
      break
    }
    const lines = Math.ceil(remaining / max)
    const target = Math.ceil(remaining / lines)
    const slack = Math.max(2, Math.ceil(max / 4))
    // 残りが、あと (lines - 1) 行に収まる長さより短くは切らない(切ると1行増える)
    const lo = Math.max(1, target - slack, remaining - max * (lines - 1))
    // 区切りの良さから、平均の長さからの離れ具合を引いて比べる(良い区切りでも遠すぎれば選ばない)
    let best = -1
    let bestValue = -Infinity
    let bestDist = Infinity
    for (let len = Math.min(max, target + slack); len >= lo; len--) {
      const sc = breakScore(chars, from + len)
      if (sc === -Infinity) continue
      const dist = Math.abs(len - target)
      const value = sc - dist * 0.5
      // 同じ値なら、平均の長さに近い方
      if (value > bestValue || (value === bestValue && dist < bestDist)) {
        best = from + len
        bestValue = value
        bestDist = dist
      }
    }
    const cut = best > from ? best : findBreak(chars, from, max)
    ends.push(cut)
    from = cut
  }
  return ends
}

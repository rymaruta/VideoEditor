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

export const FILLER =
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

/**
 * 登録された置き換えを当てる。前から1回だけ読み、その位置で一番長く合うものを当てる
 * (短いものが長いものの一部を先に壊さないように)。
 *
 * 置き換えた後の文字は読み直さない。1件ずつ全体に当てると、前の置き換えの結果を後の置き換えが
 * また書き換えていた(「きむら → 木村」「木 → 樹」で「樹村」、「ジョウド → ジョウドガハマ」で
 * すでに正しい「ジョウドガハマ」が「ジョウドガハマガハマ」に伸びた)。
 * 正しい書き方(置き換え先)がそのまま出てきたら、そこは触らない
 */
export function applyDictionary(text: string, entries: readonly DictionaryEntry[]): string {
  const d = dictionaryPattern(entries)
  return d ? text.replace(d.pattern, (m) => d.replace.get(m) ?? m) : text
}

/** 辞書を当てる正規表現と置き換え(`applyDictionary` と、文字の出どころを追う整えで同じものを使う) */
export function dictionaryPattern(
  entries: readonly DictionaryEntry[]
): { pattern: RegExp; replace: Map<string, string> } | null {
  const replace = new Map<string, string>()
  for (const e of entries) if (e.from && !replace.has(e.from)) replace.set(e.from, e.to)
  if (replace.size === 0) return null
  const keep = new Set(entries.map((e) => e.to).filter((t) => t && !replace.has(t)))
  const candidates = [...replace.keys(), ...keep].sort((a, b) => b.length - a.length)
  const escape = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return { pattern: new RegExp(candidates.map(escape).join('|'), 'gu'), replace }
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
export const NO_LINE_START =
  /[、。,.!?！？)）」』】ゝゞーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ・…]/u
/** 行末に置かない文字 */
export const NO_LINE_END = /[(（「『【]/u
const PUNCT = /[、。！？!?,.\s]/u
const PARTICLE = /[はがをにでともへやのね]/u
const KANA = /[぀-ヿ]/u
const KANJI = /[一-鿿々]/u
const HIRAGANA = /[ぁ-ゟ]/u
const KATAKANA = /[ァ-ヿ]/u
const DIGIT = /[0-9０-９]/u
/** 文節の終わりになる仮名(助詞・接続の「て」「ば」など)。この後ろは区切ってよい */
const PHRASE_END = /[はがをにでともへやのねよてばどら]/u
/** 前の言葉にくっつく仮名(助詞・助動詞・活用の頭・小さい仮名)。この前では区切らない */
const ATTACHES = /[はがをにでともへやのねよかばてただなんるっゃゅょぁぃぅぇぉゎー]/u

/**
 * k 文字目の手前で区切る良さ(大きいほど良い)。区切れない所は -Infinity。
 * chars[k-1] が行末、chars[k] が次の行頭になる。
 */
/** 前の文字とくっついて1文字になるもの */
const JOINS_PREVIOUS =
  /^(?:\u200d|[\ufe00-\ufe0f]|[\u{1f3fb}-\u{1f3ff}]|[\u{e0020}-\u{e007f}]|\p{M})/u

/** 単語の途中で区切る良さ。ほかに区切れる所が無いときだけ選ばれるよう、どの区切りよりも低くする */
export const INSIDE_WORD_SCORE = -3

const wordSegmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('ja', { granularity: 'word' })
    : null
const boundaryCache = new WeakMap<readonly string[], Set<number>>()

/**
 * 単語の切れ目(文字の位置。`chars[k]` から新しい単語が始まる k の集合)。
 * 音声認識の言葉の区切りは文節より長い(「ここ横浜国大の偉い人がいるような建物の前なんですが」で1つ)ので、
 * 辞書で日本語を単語に分ける `Intl.Segmenter` を使う。使えない環境では null(従来の文字の種類だけで判断)
 */
function wordBoundaries(chars: readonly string[]): Set<number> | null {
  if (!wordSegmenter) return null
  const cached = boundaryCache.get(chars)
  if (cached) return cached
  // Segmenter の位置は UTF-16 の位置なので、文字(コードポイント)の位置へ直す
  const charAt = new Map<number, number>()
  let unit = 0
  chars.forEach((c, i) => {
    charAt.set(unit, i)
    unit += c.length
  })
  const set = new Set<number>()
  for (const seg of wordSegmenter.segment(chars.join(''))) {
    const i = charAt.get(seg.index)
    if (i !== undefined) set.add(i)
  }
  boundaryCache.set(chars, set)
  return set
}

export function breakScore(chars: readonly string[], k: number): number {
  if (k <= 0 || k >= chars.length) return -Infinity
  const prev = chars[k - 1]
  const next = chars[k]
  // 絵文字の組み合わせ(ZWJ・肌の色・異体字セレクタ)・後ろに付けた濁点の途中では切らない
  if (JOINS_PREVIOUS.test(next) || prev === '\u200d') return -Infinity
  if (NO_LINE_START.test(next) || NO_LINE_END.test(prev)) return -Infinity
  // 数字の桁区切り・小数点(「2,800」「1.5」)の後では切らない。句読点の後として一番良い区切りになり、
  // 「お会計は2,」/「800円」と分かれたうえ、行末のカンマは整えるときに落ちて「2」「800円」と出ていた
  if (/[,.，．]/u.test(prev) && /[0-9０-９]/u.test(chars[k - 2] ?? '') && /[0-9０-９]/u.test(next))
    return -Infinity
  // 数字の途中・数字と「%」の間(「200 / 0円」「約4 / %弱」)では切らない
  if (DIGIT.test(prev) && (DIGIT.test(next) || /[%％‰]/u.test(next))) return -Infinity
  if (PUNCT.test(prev)) return 3
  // 単語の途中(「カ / ラス」「で / すね」「み / たい」)では、ほかに区切れる所があれば切らない。
  // 実写の素材(12分の食べ歩き)では、テロップの境目・改行 248 か所のうち 45 か所が単語の途中だった
  // (「と / ころ」「200 / 0円」)
  if (wordBoundaries(chars)?.has(k) === false) return INSIDE_WORD_SCORE
  if (PARTICLE.test(prev) && !PARTICLE.test(next) && KANA.test(prev)) return 2
  if (KANA.test(prev) && KANJI.test(next)) return 1
  return 0
}

/** 文の終わりらしい形(句点の無い話し言葉の文末) */
const SENTENCE_END =
  /(?:ます|です|ました|でした|ません|ませんでした|ましょう|でしょう|ください|ですね|ますね|ですよ|ますよ|ですか|ますか|よね|った|んだ|んです|のだ|うだ|ない|ありがとう|ございます)$/u

/** chars[k] の手前が、文の終わりらしい形で終わっているか */
function endsSentence(chars: readonly string[], k: number): boolean {
  const tail = chars.slice(Math.max(0, k - 6), k).join('')
  return SENTENCE_END.test(tail)
}

/**
 * 改行・テロップの境目の位置としての良さ(`breakScore` に、日本語の文節の切れ目の見当を足したもの)。
 * `Intl.Segmenter` の日本語の単語の区切りは活用・複合語を細かく切る(「思い|切|っ|た」「聞|か|せい|ただ|きた|い」
 * 「もつ|な|が|って」)ので、それだけに頼ると「会長の思い / 切った」「お聞かせいただ / きたい」「つな / がって」
 * のように語の途中で改行していた(試し編集 第2回)。仮名の並びの中は、文節の終わりの仮名(助詞・「て」)の
 * 後ろで、次が前にくっつく仮名でない所だけを区切りとし、漢字・カタカナの後ろの仮名(送り仮名・助詞)の前と、
 * 漢字+送り仮名1文字+漢字(「思い切る」「受け入れ」「話し合い」)の途中は単語の途中と同じ扱いにする
 */
export function lineBreakScore(chars: readonly string[], k: number): number {
  let base = breakScore(chars, k)
  if (base === -Infinity || base >= 3) return base
  const prev = chars[k - 1]
  const next = chars[k]
  const before = chars[k - 2] ?? ''
  // 単語の区切りが助詞を後ろの言葉の頭に付けて分けた所(「皆様|がい|ら」「に|もつ|な|が」)は、助詞の後ろを
  // 語の切れ目とみなす。名詞(漢字・カタカナ)の後ろの助詞と、助詞に続く「を」「も」「は」だけ
  if (
    base === INSIDE_WORD_SCORE &&
    /[はがをにでとものへや]/u.test(prev) &&
    (KANJI.test(before) ||
      KATAKANA.test(before) ||
      (PARTICLE.test(before) && /[をもは]/u.test(prev))) &&
    (HIRAGANA.test(next) || KANJI.test(next)) &&
    !ATTACHES.test(next) &&
    !(prev === 'で' && next === 'す') &&
    wordBoundaries(chars)?.has(k - 1) === true
  )
    base = 2
  // 句点が無くても文の終わりらしい所(「…ました / それでは」「…ですね / 以前」)は、次が前にくっつく仮名で
  // なければ切ってよい(仮名の並びの中を全部語の途中とみなすと「ありがとうございまし / た…」になった)
  if (base > -Infinity && !ATTACHES.test(next) && endsSentence(chars, k)) return Math.max(base, 2)
  if (HIRAGANA.test(next)) {
    // 漢字・カタカナ・数字の後ろの助詞・送り仮名・「する」の活用(「経済 / にとって」「競合 / しない」)
    if (
      (KANJI.test(prev) || KATAKANA.test(prev) || DIGIT.test(prev)) &&
      (ATTACHES.test(next) || /[しすさせ]/u.test(next))
    )
      return Math.min(base, INSIDE_WORD_SCORE)
    if (HIRAGANA.test(prev) && (!PHRASE_END.test(prev) || ATTACHES.test(next)))
      return Math.min(base, INSIDE_WORD_SCORE)
  }
  // 「お」「ご」+漢字(「お聞かせ」「ご案内」)の間
  if (KANJI.test(next) && /[おご]/u.test(prev)) return Math.min(base, INSIDE_WORD_SCORE)
  // 漢字+送り仮名1文字+漢字(複合語の途中)
  if (KANJI.test(next) && HIRAGANA.test(prev) && !PARTICLE.test(prev) && KANJI.test(before))
    return Math.min(base, INSIDE_WORD_SCORE)
  return base
}

/**
 * 長さ `max` 以内で、良い区切りを探す。後ろ半分の中から点数の高い所(同点なら後ろ)を選ぶ。
 * どこも区切れなければ、禁則の文字を1つだけ前の行にぶら下げる。
 */
export function findBreak(
  chars: readonly string[],
  from: number,
  max: number,
  score: (chars: readonly string[], k: number) => number = breakScore
): number {
  const limit = Math.min(chars.length, from + max)
  if (limit >= chars.length) return chars.length
  let best = -1
  let bestScore = -Infinity
  for (let k = limit; k > from + Math.floor(max / 2); k--) {
    const sc = score(chars, k)
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
export function balancedLineEnds(
  chars: readonly string[],
  maxLine: number,
  /** 切ってはいけない位置(辞書で直す言葉の途中など) */
  noCut?: (index: number) => boolean,
  /**
   * 文節の切れ目の見当(`lineBreakScore`)で選ぶ。語の途中でしか切れないときは、1行増やしてでも語の切れ目で
   * 切る(テロップの1枚の中の改行。行が増えた分は次の枚になる)
   */
  phrases = false
): number[] {
  const score = phrases ? lineBreakScore : breakScore
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
      if (noCut?.(from + len)) continue
      const sc = score(chars, from + len)
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
    // 平均の長さの近くでは語の途中でしか切れないなら、行の数を変えずに切れる範囲の全部から、語の切れ目を探す
    // (「ぜひお聞かせいただ / きたいなと思います」より「…いただきたいなと / 思います」)。行の数は変えない
    // (1枚に入る行の数を超えると枚が増え、何枚目かで覚えた人の修正・消した印が別の枚に当たる)
    if (phrases && best > from && lineBreakScore(chars, best) < 0) {
      let alt = -1
      let altValue = -Infinity
      for (let len = max; len >= Math.max(1, remaining - max * (lines - 1)); len--) {
        if (noCut?.(from + len)) continue
        const sc = lineBreakScore(chars, from + len)
        if (sc < 0) continue
        const value = sc - Math.abs(len - target) * 0.5
        if (value > altValue) {
          alt = from + len
          altValue = value
        }
      }
      if (alt > from) best = alt
    }
    const cut = best > from ? best : findBreak(chars, from, max, score)
    ends.push(cut)
    from = cut
  }
  return ends
}

/**
 * 辞書で直す言葉(置き換え前)の途中の位置。テロップを枚に分けるとき、ここで切ると言葉が2枚に分かれ、
 * どちらの枚でも辞書に当たらずに直らなかった(書き出しの確認も1枚ずつ見るので見逃していた)
 */
export function dictionaryNoCut(
  chars: readonly string[],
  entries: readonly DictionaryEntry[] | undefined
): (index: number) => boolean {
  const inside = new Set<number>()
  for (const e of entries ?? []) {
    const word = [...e.from]
    if (word.length < 2) continue
    for (let i = 0; i + word.length <= chars.length; i++) {
      let hit = true
      for (let k = 0; k < word.length && hit; k++) hit = chars[i + k] === word[k]
      if (hit) for (let k = 1; k < word.length; k++) inside.add(i + k)
    }
  }
  return (index) => inside.has(index)
}

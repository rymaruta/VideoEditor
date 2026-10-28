/**
 * 文字起こし(計画書 §5.3)と話者(§5.4)の結果の形。
 *
 * 時刻は**素材の時刻**で持つ(どの素材の何秒目か)。タイムラインの時刻で持つと、
 * カットを詰めたり並べ替えたりするたびにずれていく。タイムラインでの位置は、
 * その素材を使っているクリップから都度割り出す(`utteranceTimelineRange`)。
 */

export interface AsrJob {
  id: string
  path: string
  /** 素材の時刻(秒) */
  start: number
  end: number
}

export interface AsrWord {
  text: string
  /** 素材の時刻(秒) */
  start: number
  end: number
}

export interface AsrJobResult {
  id: string
  text: string
  words: AsrWord[]
}

export type AsrDevice = 'dml' | 'cuda' | 'cpu'

/** 文字起こしのモデル(asrWorker。環境チェックもこの名前でダウンロード済みかを見る) */
export const ASR_MODEL_ID = 'onnx-community/whisper-large-v3-turbo_timestamped'

/** 文字起こしで試す装置の順(Windows: DirectML の GPU → CPU、それ以外: CPU) */
export function asrDeviceOrder(platform: string): AsrDevice[] {
  return platform === 'win32' ? ['dml', 'cpu'] : ['cpu']
}

/**
 * 自動編集の文字起こしの言語。`auto` は素材(マイク)ごとに話している言語を判定する。
 * 日本語に固定すると、英語の素材は日本語への訳として出て、テロップが実用にならない
 */
export type AsrLanguage = 'auto' | 'japanese' | 'english' | 'chinese' | 'korean'

export const ASR_LANGUAGES: readonly AsrLanguage[] = [
  'auto',
  'japanese',
  'english',
  'chinese',
  'korean'
]

export const ASR_LANGUAGE_LABEL: Record<AsrLanguage, string> = {
  auto: '自動判定',
  japanese: '日本語',
  english: '英語',
  chinese: '中国語',
  korean: '韓国語'
}

/** 既定の言語(今までどおり日本語)。`auto` を選べば素材ごとに判定する */
export const DEFAULT_ASR_LANGUAGE: AsrLanguage = 'japanese'

export function isAsrLanguage(v: unknown): v is AsrLanguage {
  return typeof v === 'string' && (ASR_LANGUAGES as readonly string[]).includes(v)
}

/**
 * 判定した言語(Whisper の言語の印ごとの確からしさ。足して 1)から、認識に使う言語を決める。
 * 日本語以外は、それが一番で `AUTO_LANGUAGE_CONFIDENCE` 以上、かつ日本語が `AUTO_JAPANESE_MAX` 未満の
 * ときだけ使う。音楽・雑音・短い声で判定が揺れたときは日本語(今までの振る舞い)にする。
 * 実測(whisper-large-v3-turbo): 日本語の文 12 本はどれも日本語 0.9 以上、英語の記録映像は 0.42〜1.0
 * (雑音の多い窓で低い)。返すのは Whisper の言語の符号(`ja`・`en` …)
 */
export const AUTO_LANGUAGE_CONFIDENCE = 0.5
export const AUTO_JAPANESE_MAX = 0.2

/**
 * transformers.js(whisper_language_to_code)が受ける言語の符号。言語の判定は Whisper の全部の印
 * (広東語 `yue` など)から選ぶので、受けない符号をそのまま渡すと「Language "yue" is not supported」で
 * 文字起こし全体が止まっていた
 */
const WHISPER_CODES = new Set(
  (
    'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ' +
    'ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr ' +
    'pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt ' +
    'haw ln ha ba jw su'
  ).split(' ')
)
/** 受けない符号のうち、近い言語に寄せるもの */
const WHISPER_CODE_ALIASES: Record<string, string> = { yue: 'zh' }

/** 判定した言語の符号を、認識に渡せる符号にする(広東語は中国語に寄せ、受けないものは日本語) */
export function whisperLanguageCode(code: string): string {
  const c = WHISPER_CODE_ALIASES[code] ?? code
  return WHISPER_CODES.has(c) ? c : 'ja'
}

export function chooseAsrLanguage(probs: ReadonlyMap<string, number>): string {
  let best = ''
  let bestP = -1
  for (const [code, p] of probs)
    if (p > bestP) {
      best = code
      bestP = p
    }
  if (!best || best === 'ja' || bestP < AUTO_LANGUAGE_CONFIDENCE) return 'ja'
  if ((probs.get('ja') ?? 0) >= AUTO_JAPANESE_MAX) return 'ja'
  return whisperLanguageCode(best)
}

/**
 * 言語を指定して認識し、言語の指定が原因で失敗したら(受けない言語など)日本語で認識し直す。
 * 1つの窓の失敗で文字起こし全体を止めない。日本語で失敗したら、その失敗をそのまま返す
 */
export async function withLanguageFallback<T>(
  language: string,
  run: (language: string) => Promise<T>,
  fallback = 'japanese'
): Promise<T> {
  try {
    return await run(language)
  } catch (e) {
    if (language === fallback || language === 'ja') throw e
    // 言語と関係のない失敗(メモリ不足など)を日本語でやり直すと、英語の音が黙って日本語の文字になるのでやり直さない
    if (!/language/i.test(e instanceof Error ? e.message : String(e))) throw e
    return run(fallback)
  }
}

export type AsrWorkerMessage =
  | { type: 'status'; stage: 'download' | 'load'; percent: number; note: string }
  | { type: 'device'; device: AsrDevice; note?: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; result: AsrJobResult }
  | { type: 'done' }
  | { type: 'error'; message: string }

/**
 * 文字起こしの工程の進み具合(%)と説明を、認識の知らせから決める。工程の % は発話を読んだ割合だけ。
 * モデルの準備(ダウンロード・読み込み)の % は説明に出す。準備の % をそのまま工程の % にすると、
 * ダウンロード済みのモデルを読むだけでも 100% になり、続いて認識が始まると 0% 近くへ戻っていた
 * (試し編集 第2回: 0% → 100% → 8%)
 */
export function asrStepProgress(
  m: Exclude<AsrWorkerMessage, { type: 'result' | 'done' | 'error' | 'device' }>,
  /** 今出している工程の % */
  current: number
): { percent: number; note: string } {
  if (m.type === 'status') {
    const pct = Math.max(0, Math.min(100, m.percent))
    return {
      percent: current,
      note: m.stage === 'download' && pct > 0 ? `${m.note} ${Math.floor(pct)}%` : m.note
    }
  }
  return {
    percent: Math.max(current, (m.done / Math.max(1, m.total)) * 100),
    note: `${m.done}/${m.total}`
  }
}

export interface TranscriptUtterance {
  id: string
  /** 声を拾った素材(ピンマイクがあればその人のマイク) */
  assetId: string
  /** 話者(出演者の名前)。分からなければ undefined */
  speaker?: string
  /** 素材の時刻(秒) */
  sourceStart: number
  sourceEnd: number
  text: string
  words: AsrWord[]
  /** ほかの人と声が重なっている */
  overlap: boolean
}

/**
 * 数字の直後に付く単位(これで始まる発話は、数字で終わる前の発話の続き)。「人」「年」「分」「日」は言葉の頭にも
 * なる(「人生」「分かる」「日本」)ので入れない
 */
const UNIT_HEAD = /^[、,\s]*(?:[%％‰円割倍万億兆歳個件]|パーセント)/u
/** 数字で終わる(後ろの句読点・空白は除く) */
const DIGIT_TAIL = /[0-9０-９][\s、,]*$/u
/** 数字と単位を分けた発話をつなぐ、前の発話の終わりから次の頭までの間の上限(秒) */
export const SPLIT_NUMBER_GAP_SEC = 1.5

/**
 * 数字と単位(「%」「円」など)の間で分かれた発話をつなぐ。発話は声の間で区切るので、「約4」と言って
 * 少し間を置いて「%弱ぐらいの賃上げを」と続けると別の発話になり、文字起こしの文・発言テロップが「約4」だけで
 * 1秒出ていた(試し編集 第2回)。同じ素材・同じ話者で、間が `SPLIT_NUMBER_GAP_SEC` 以内のものだけ
 */
export function joinSplitNumbers(list: readonly TranscriptUtterance[]): TranscriptUtterance[] {
  const order = [...list].sort((a, b) => a.sourceStart - b.sourceStart)
  const merged = new Map<TranscriptUtterance, TranscriptUtterance>()
  const dropped = new Set<TranscriptUtterance>()
  const lastOf = new Map<string, TranscriptUtterance>()
  for (const u of order) {
    const key = `${u.assetId}\u0000${u.speaker ?? ''}`
    const prevU = lastOf.get(key)
    const prev = prevU ? (merged.get(prevU) ?? prevU) : undefined
    if (
      prevU &&
      prev &&
      !prev.overlap &&
      !u.overlap &&
      DIGIT_TAIL.test(prev.text) &&
      UNIT_HEAD.test(u.text) &&
      u.sourceStart - prev.sourceEnd <= SPLIT_NUMBER_GAP_SEC
    ) {
      const head = u.text.replace(/^[、,\s]+/u, '')
      merged.set(prevU, {
        ...prev,
        text: `${prev.text.replace(/[\s、,]+$/u, '')}${head}`,
        sourceEnd: Math.max(prev.sourceEnd, u.sourceEnd),
        words: [...prev.words, ...u.words]
      })
      dropped.add(u)
      continue
    }
    lastOf.set(key, u)
  }
  if (dropped.size === 0) return [...list]
  return list.filter((u) => !dropped.has(u)).map((u) => merged.get(u) ?? u)
}

/**
 * 声の無い所で音声認識が出しがちな決まり文句(学習に使われた動画の締めの挨拶など)。
 * 発話の区間だけを認識にかけるので滅多に出ないが、出たら捨てる。
 */
const HALLUCINATIONS = [
  /^(ご視聴|ご清聴)ありがとうございました[。!！]?$/,
  /^チャンネル登録(よろしく|お願い)/,
  /^(字幕|翻訳)(:|：)/,
  /^[.。…・\s]+$/
]

/**
 * 音声認識の「繰り返しの暴走」: 同じ言葉が切れ目なく続き、発話の大半を占める
 * (「ヴィヴィヴィヴィ…」「彼女彼女彼女…」「私は 私は 私は…」)。雑音・音楽・聞き取れない言葉で起きる。
 *
 * 言葉は空白・句読点を除き、小文字にして比べる(「I'm going to get the car.」と「car. I'm going」の区切りの
 * 違いで見逃さない)。数える回数は言葉の長さで変える:
 * - 時刻を見ないとき(文字だけで決める): 人の掛け声(「いけいけいけ」「ラッシュ ラッシュ」)と見分けるため、
 *   2 種類以上の文字の言葉で、2〜4 文字は 10 回、5〜10 文字は 6 回、11 文字以上(文)は 4 回以上続いたもの。
 *   1 文字の繰り返し(叫び「うわああああ」・笑い「はははは」・伸ばす「えーーーー」)は人の声なので数えない
 * - 時刻が分かり、その所の話す速さが極端に遅い(1 秒に 1.5 文字未満が 3 秒以上)とき: 2 文字以上の言葉は
 *   4 回、1 文字は 8 回以上(1 秒に 1 文字未満)続けば作り話(「2分間2分間2分間2分間」を 10 秒・
 *   「んんんんん…」を 20 秒)。人が繰り返して言う言葉(「はいはいはい」「やばいやばいやばい」・笑い)は
 *   話す速さで言うので数えない。ゆっくり言う短い返事(「はい。はい。はい。」)・終わりの分からない片の長さは
 *   遅さに使わない(`slowLoop`)
 */
const MAX_UNIT = 40
/** 繰り返しが発話のこれだけを占めたら、暴走とみなして捨てる */
const LOOP_SHARE = 0.6
/** これより遅い所(1 秒の文字数)の繰り返しは、少ない回数でも作り話とみなす */
const SLOW_CHARS_PER_SEC = 1.5
/** 遅さを見る最短の長さ(秒)。短い所の時刻は粗い(0.02 秒刻み・長さ 0 の言葉)ので見ない */
const SLOW_MIN_SEC = 3
/** 1 秒にこれより多い文字は人には話せない(早口の日本語でも 1 秒に 10 文字ほど) */
const FAST_CHARS_PER_SEC = 40
const FAST_MIN_CHARS = 20
/**
 * 言葉の時刻を足した長さに対して、これより少ない文字(1 秒に 0.4 文字)が 10 秒以上続く発話は作り話
 * (声の無い所に言葉の時刻を引き伸ばしたもの)。言葉の間の無音は数えないので、間を空けて話した発話は当たらない
 */
const SPARSE_CHARS_PER_SEC = 0.4
const SPARSE_MIN_SEC = 10
/** 発話をまたいだ繰り返しを見るとき、これより間が空いた発話どうしはつながない(秒) */
const ACROSS_GAP_SEC = 1

/** 比べるための文字(空白・句読点を除き小文字に) */
const SKIP_CHAR = /[\s\p{P}]/u

function normalizedChars(text: string): string[] {
  const out: string[] = []
  for (const ch of text) if (!SKIP_CHAR.test(ch)) out.push(ch.toLowerCase())
  return out
}

interface Loop {
  from: number
  to: number
}

/**
 * 繰り返しを左から探す。`qualifies(単位の長さ, 回数, 範囲)` が作り話と認めた中で一番長く覆うものを取る
 */
function findLoops(
  chars: readonly string[],
  qualifies: (unit: readonly string[], repeats: number, from: number, to: number) => boolean
): Loop[] {
  const n = chars.length
  const out: Loop[] = []
  for (let i = 0; i < n;) {
    let best: Loop | null = null
    for (let L = 1; L <= MAX_UNIT && i + 2 * L <= n; L++) {
      let r = 1
      outer: while (i + (r + 1) * L <= n) {
        for (let k = 0; k < L; k++) if (chars[i + k] !== chars[i + r * L + k]) break outer
        r++
      }
      if (r < 2) continue
      const to = i + r * L
      if (best && to - i <= best.to - best.from) continue
      if (qualifies(chars.slice(i, i + L), r, i, to)) best = { from: i, to }
    }
    if (best) {
      out.push(best)
      i = best.to
    } else i++
  }
  return out
}

/** 文字だけで決める繰り返しの暴走(時刻を見ない) */
function strictLoop(unit: readonly string[], repeats: number): boolean {
  if (new Set(unit).size < 2) return false
  const L = unit.length
  return repeats >= (L <= 4 ? 10 : L <= 10 ? 6 : 4)
}

/**
 * 人がよく繰り返す短い返事・相づち。ゆっくり間を空けて言う(「はい。……はい。……はい。」)ので、
 * 遅さでは作り話と見分けられない。遅さでの判定から外す(文字だけの判定 `strictLoop` は掛ける)
 */
const SHORT_REPLIES = new Set([
  'はい',
  'うん',
  'ええ',
  'そう',
  'いや',
  'ああ',
  'おう',
  'yes',
  'no',
  'ok',
  'okay',
  'yeah'
])
/** 1 文字の繰り返しを遅さで捨てるときの、さらに遅い速さ(1 秒の文字数)。歌の「ラララ」・数えるのを残す */
const SLOW_SINGLE_CHARS_PER_SEC = 1
/**
 * 1 文字が 5〜7 回でも、1 文字に 2 秒以上かけた繰り返しは作り話(「ん」×6 を 20 秒)。
 * 本当の「んんん」(1 秒に 1 文字ほど)・「んー」(伸ばす記号で別の文字)は当たらない。
 * 作り話の形(声にならない1文字を、1つの片の中で区切らずに引き伸ばしたもの)に限る。ゆっくり数える
 * 「1、1、1、1、1」・マイクテストの「あ、あ、あ」・片をまたいだ「ん。」の連続は本当の言葉(`VERY_SLOW_SINGLE_UNITS`)
 */
const VERY_SLOW_SINGLE_CHARS_PER_SEC = 0.5
const VERY_SLOW_SINGLE_REPEATS = 5
/** とても遅い繰り返しを作り話とみなす1文字(声にならない「ん」) */
const VERY_SLOW_SINGLE_UNITS = new Set(['ん', 'ン', 'ﾝ'])

/** 繰り返しの一番短い元の単位(「はいはい」→「はい」) */
function primitiveUnit(unit: readonly string[]): readonly string[] {
  const L = unit.length
  for (let p = 1; p < L; p++) {
    if (L % p !== 0) continue
    let ok = true
    for (let k = p; k < L && ok; k++) ok = unit[k] === unit[k - p]
    if (ok) return unit.slice(0, p)
  }
  return unit
}

/**
 * よく言う返事の繰り返しか。繰り返しはどこから数えても同じなので、単位をずらした形(「いは」)・
 * 倍の単位(「はいはい」)も、元の単位を回して返事と比べる(ずらした単位では返事と見分けられず、
 * 「はい。」×5 を捨て、間を空けた「うん」5つの途中だけを捨てていた)
 */
function isShortReplyUnit(unit: readonly string[]): boolean {
  const root = primitiveUnit(unit)
  for (let r = 0; r < root.length; r++)
    if (SHORT_REPLIES.has([...root.slice(r), ...root.slice(0, r)].join(''))) return true
  return false
}

/**
 * 速さを見たときの、少ない回数の繰り返し。本当にゆっくり繰り返して言う言葉(「はい。はい。はい。」・
 * 間を空けた相づち「うん」3つ・数える「1、1、1、1、1」・歌の「ラララ ラララ」)を消さないよう、
 * 2 文字以上の言葉は 4 回以上(「2分間」×4)、1 文字は 8 回以上かつ 1 秒に 1 文字未満
 * (「んんんんんんんんんんん」を 20 秒)を求め、よく言う短い返事は数えない
 */
function slowLoop(
  unit: readonly string[],
  repeats: number,
  charsPerSec: number,
  /** 繰り返しが1つの片の中で、区切り(空白・句読点)なしに続いているか */
  unbroken: boolean
): boolean {
  if (new Set(unit).size < 2)
    return (
      (repeats >= 8 && charsPerSec < SLOW_SINGLE_CHARS_PER_SEC) ||
      (unbroken &&
        VERY_SLOW_SINGLE_UNITS.has(unit[0]) &&
        repeats >= VERY_SLOW_SINGLE_REPEATS &&
        charsPerSec < VERY_SLOW_SINGLE_CHARS_PER_SEC)
    )
  if (isShortReplyUnit(unit)) return false
  return repeats >= 4
}

function repetitionLoopLength(t: string): number {
  const chars = normalizedChars(t)
  let covered = 0
  for (const l of findLoops(chars, strictLoop)) covered += l.to - l.from
  return chars.length === 0 ? 0 : (covered / chars.length) * t.length
}

/**
 * 決まり文句の作り話(「ご視聴ありがとうございました」など。本当に言うこともある)か。
 * 決まり文句をそのまま繰り返したもの(「ご視聴ありがとうございました。」×3)も決まり文句とする
 * (2 文字以上の言葉は遅くても 4 回から繰り返しとみなすので、3 回では見逃していた)
 */
export function isStockHallucination(text: string): boolean {
  const t = text.trim()
  if (t === '') return false
  if (HALLUCINATIONS.some((r) => r.test(t))) return true
  const chars = normalizedChars(t)
  const unit = primitiveUnit(chars)
  if (unit.length === chars.length) return false
  const one = unit.join('')
  return HALLUCINATIONS.some((r) => r.test(one))
}

/** 文字だけで見た作り話(決まり文句・長い繰り返し)。時刻が分かるなら `hallucinatedIndices` も使う */
export function isLikelyHallucination(text: string): boolean {
  const t = text.trim()
  if (t === '' || isStockHallucination(t)) return true
  return repetitionLoopLength(t) >= t.length * LOOP_SHARE
}

/** 時刻の付いた文字起こしの1片(発話・区切り) */
export interface TimedText {
  text: string
  start: number
  end: number
  words?: readonly { start: number; end: number; text?: string }[]
  /**
   * 終わりの時刻が認識から返らず、推し量った値(区間の終わりまで伸ばした等)か。推し量った長さは
   * 話す速さの判定(遅すぎる繰り返し)に使わない(区間の終わりまで伸びた「はい、はい、はい」を捨てていた)
   */
  endUnknown?: boolean
}

/** 言葉の時刻の幅(頭から終わり)と、言葉の長さの合計 */
function spans(item: TimedText): { span: number; spoken: number } {
  const ws = item.words?.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end)) ?? []
  if (ws.length === 0) {
    const d = Math.max(0, item.end - item.start)
    return { span: d, spoken: d }
  }
  let spoken = 0
  for (const w of ws) spoken += Math.max(0, w.end - w.start)
  const span = Math.max(0, ws[ws.length - 1].end - ws[0].start)
  return { span, spoken }
}

/**
 * 同じ素材の文字起こしの片のうち、作り話のもの(の添字)。片は時刻の順でなくてよい。
 * - 繰り返しの暴走(上の規則。発話をまたいで続くものも、間が 1 秒以内ならつないで見る)が片の 6 割以上
 * - 話す速さに対して文字が極端に多い(1 秒に 40 文字を超える)・少ない(言葉の長さの合計 10 秒以上に 1 秒 0.4 文字未満)
 * 決まり文句(「ご視聴ありがとうございました」)はここでは見ない(`isStockHallucination`)
 */
export function hallucinatedIndices(items: readonly TimedText[]): Set<number> {
  const drop = new Set<number>()
  const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start)
  let group: number[] = []
  const flush = (): void => {
    if (group.length > 0) loopsAcross(items, group, drop)
    group = []
  }
  for (const i of order) {
    const it = items[i]
    const n = normalizedChars(it.text).length
    const { span, spoken } = spans(it)
    if (n >= FAST_MIN_CHARS && n > FAST_CHARS_PER_SEC * span) drop.add(i)
    // 長さ 0 の片(言葉がみな同じ時刻)は繰り返しを探す並びに入れない(作り話の繰り返しの途中に挟まると、
    // 繰り返しが2つに分かれて回数が足りなくなる)
    if (span <= 1e-6) continue
    // 少なすぎる文字は、言葉の時刻があるときだけ見る(区切りの時刻だけの片は、無音をまたいで長いことがある)
    const timedWords = (it.words?.length ?? 0) > 0
    if (timedWords && n > 0 && spoken >= SPARSE_MIN_SEC && n < SPARSE_CHARS_PER_SEC * spoken)
      drop.add(i)
    if (drop.has(i)) continue
    const prev = group.length > 0 ? items[group[group.length - 1]] : null
    if (prev && it.start - prev.end > ACROSS_GAP_SEC) flush()
    group.push(i)
  }
  flush()
  return drop
}

/** つながった片の文字を並べて繰り返しを探し、6 割以上が繰り返しの片を `drop` に入れる */
function loopsAcross(
  items: readonly TimedText[],
  group: readonly number[],
  drop: Set<number>
): void {
  const chars: string[] = []
  const owner: number[] = []
  /** 文字ごとの話している長さ(片の言葉の長さを文字数で割る)。遅さを見るのに使う */
  const sec: number[] = []
  /** その文字の前(同じ片の中)に区切り(空白・句読点)があるか */
  const broken: boolean[] = []
  for (const i of group) {
    const cs = normalizedChars(items[i].text)
    // 終わりの分からない片の長さは数えない(遅さの判定で、その片の文字は時間を取らないものとする)
    const per = cs.length > 0 && !items[i].endUnknown ? spans(items[i]).spoken / cs.length : 0
    let gap = false
    for (const ch of items[i].text) {
      if (SKIP_CHAR.test(ch)) {
        gap = true
        continue
      }
      chars.push(ch.toLowerCase())
      owner.push(i)
      sec.push(per)
      broken.push(gap)
      gap = false
    }
  }
  if (chars.length < 2) return
  const prefix = [0]
  for (const s of sec) prefix.push(prefix[prefix.length - 1] + s)
  const unbrokenRun = (from: number, to: number): boolean => {
    for (let k = from + 1; k < to; k++) if (owner[k] !== owner[from] || broken[k]) return false
    return true
  }
  const loops = findLoops(chars, (unit, repeats, from, to) => {
    if (strictLoop(unit, repeats)) return true
    const d = prefix[to] - prefix[from]
    return (
      d >= SLOW_MIN_SEC &&
      to - from < SLOW_CHARS_PER_SEC * d &&
      slowLoop(unit, repeats, (to - from) / d, unbrokenRun(from, to))
    )
  })
  if (loops.length === 0) return
  const covered = new Map<number, number>()
  for (const l of loops)
    for (let k = l.from; k < l.to; k++) covered.set(owner[k], (covered.get(owner[k]) ?? 0) + 1)
  for (const i of group) {
    const n = normalizedChars(items[i].text).length
    if (n > 0 && (covered.get(i) ?? 0) >= n * LOOP_SHARE) drop.add(i)
  }
}

/** クリップの形(タイムラインでの位置を割り出すのに要る所だけ) */
export interface PlacedClipRef {
  assetId: string
  startTime: number
  inPoint: number
  outPoint: number
  speed?: number
}

/**
 * 発話がタイムラインのどこにあるか。その素材を使っているクリップのうち、発話の頭を含むものから割り出す。
 * どのクリップにも入っていなければ null(カットで落とした部分の発話)。
 */
export function utteranceTimelineRange(
  u: Pick<TranscriptUtterance, 'assetId' | 'sourceStart' | 'sourceEnd'>,
  clips: readonly PlacedClipRef[]
): { start: number; end: number } | null {
  for (const c of clips) {
    if (c.assetId !== u.assetId) continue
    if (u.sourceStart < c.inPoint - 1e-6 || u.sourceStart >= c.outPoint) continue
    const speed = c.speed && c.speed > 0 ? c.speed : 1
    const start = c.startTime + (u.sourceStart - c.inPoint) / speed
    const end = c.startTime + (Math.min(u.sourceEnd, c.outPoint) - c.inPoint) / speed
    return { start, end }
  }
  return null
}

/**
 * 区間を指定して文字起こしした結果を、その区間に収める。
 * - 認識の作り話(無音・雑音で出る「ご視聴ありがとうございました」・同じ言葉の繰り返し)は捨てる
 * - 区間の終わりより後ろで始まる言葉は捨て、時刻は区間の中に収める
 * (自動のテロップ・カラオケが、無音の所に出たり、クリップの終わりより 20 秒以上後ろに置かれたりしていた)
 */
export function fitSegmentsToRange<
  S extends {
    start: number
    end: number
    text: string
    words?: { start: number; end: number; text: string }[]
  }
>(
  segments: readonly S[],
  rangeStart: number,
  rangeEnd: number,
  /**
   * その時刻の音がほぼ無音か。決まり文句(「ご視聴ありがとうございました」)は、無音の所に出たときだけ
   * 作り話として捨てる(番組の締めで本当に言った言葉まで、テロップから消えていた)。省略時は常に捨てる
   */
  isQuiet?: (start: number, end: number) => boolean
): S[] {
  const clamp = (t: number): number => Math.min(rangeEnd, Math.max(rangeStart, t))
  // 繰り返しの作り話(区切りをまたいで続くもの・話す速さに合わないものも)と、長さ 0 の区切り
  // (言葉がみな同じ時刻)は、音が鳴っていても捨てる。音楽・効果音の所で「I'm going to get the car.」を
  // 13 回、長さ 0 の区切りを出していた
  const made = hallucinatedIndices(segments)
  const out: S[] = []
  for (const [si, seg] of segments.entries()) {
    if (made.has(si) || spans(seg).span <= 1e-6) continue
    if (isLikelyHallucination(seg.text)) {
      // 決まり文句だけなら、音が鳴っている所のものは本当の言葉として残す(繰り返しの作り話は常に捨てる)
      const t = seg.text.trim()
      const repetition = repetitionLoopLength(t) >= t.length * LOOP_SHARE
      const spoken = isQuiet !== undefined && !isQuiet(seg.start, seg.end)
      if (!(isStockHallucination(t) && !repetition && spoken)) continue
    }
    if (!seg.words) {
      if (seg.start >= rangeEnd) continue
      out.push({ ...seg, start: clamp(seg.start), end: Math.max(clamp(seg.start), clamp(seg.end)) })
      continue
    }
    const words = seg.words
      .filter((w) => w.start < rangeEnd)
      .map((w) => ({ ...w, start: clamp(w.start), end: Math.max(clamp(w.start), clamp(w.end)) }))
    if (words.length === 0) continue
    out.push({
      ...seg,
      words,
      start: words[0].start,
      end: words[words.length - 1].end,
      text: words.map((w) => w.text).join('')
    })
  }
  return out
}

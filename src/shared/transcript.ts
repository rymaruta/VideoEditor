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

export type AsrWorkerMessage =
  | { type: 'status'; stage: 'download' | 'load'; percent: number; note: string }
  | { type: 'device'; device: AsrDevice; note?: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; result: AsrJobResult }
  | { type: 'done' }
  | { type: 'error'; message: string }

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
 * 音声認識の「繰り返しの暴走」: 同じ短い言葉(10 文字まで)が切れ目なく 8 回以上続く
 * (「ヴィヴィヴィヴィ…」「彼女彼女彼女…」「私は 私は 私は…」)。雑音・音楽・聞き取れない言葉で起きる。
 * 人が言う繰り返し(「やばいやばいやばい」)は 8 回に届かない
 */
const REPETITION_LOOP = /(\S.{0,9}?)(?:[\s、。,.]*\1){7,}/u
/** 繰り返しが発話のこれだけを占めたら、暴走とみなして捨てる */
const LOOP_SHARE = 0.6

export function isLikelyHallucination(text: string): boolean {
  const t = text.trim()
  if (t === '' || HALLUCINATIONS.some((r) => r.test(t))) return true
  const loop = REPETITION_LOOP.exec(t)
  return loop !== null && loop[0].length >= t.length * LOOP_SHARE
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

/**
 * 音声クリップのフェードイン/アウトの規則。
 *
 * プレビュー(Web Audio の音量)と書き出し(ffmpeg の `afade`)で別々に計算すると、
 * 画面で聞いた音と出来上がりが黙って食い違う。規則はここ1箇所だけに置き、両方が呼ぶ。
 *
 * 秒数は**タイムライン上の秒**(速度を掛けたあとの尺に対する秒)で扱う。
 * 書き出しでは `atempo` のあとに `afade` を挟むので、こちらの時間軸と一致する。
 */

/** 有限で0以上の秒数に整える。負値・NaN・未設定はすべて 0(フェードなし) */
function sanitize(seconds: number | undefined): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 0
  return seconds
}

/**
 * クリップの尺に収まるフェード秒数を返す。
 *
 * 合計が尺を超えるときは**比を保ったまま**縮めて、ちょうど尺に収める。
 * 片方だけ黙って切り詰めると、利用者が入れた比率が理由なく崩れる。
 * ffmpeg には定義域外(負・尺超過)の値を渡さない。
 */
export function normalizeFades(
  fadeIn: number | undefined,
  fadeOut: number | undefined,
  clipDuration: number
): { fadeIn: number; fadeOut: number } {
  const dur = Number.isFinite(clipDuration) && clipDuration > 0 ? clipDuration : 0
  if (dur === 0) return { fadeIn: 0, fadeOut: 0 }
  const inSec = sanitize(fadeIn)
  const outSec = sanitize(fadeOut)
  const total = inSec + outSec
  // 先に片方ずつ尺で頭打ちにすると、そのあと比で縮めたときに比が変わってしまう
  // (1秒:3秒 を尺2秒に入れると 1:2 になってしまった)。縮めるのは1回だけにする。
  if (total > dur) {
    const scale = dur / total
    return { fadeIn: inSec * scale, fadeOut: outSec * scale }
  }
  return { fadeIn: inSec, fadeOut: outSec }
}

/**
 * クリップ内の経過秒に対する音量倍率(0〜1)。
 * ffmpeg の `afade` は既定カーブが `tri`(直線)なので、こちらも直線で合わせる。
 */
export function fadeGainAt(
  elapsed: number,
  clipDuration: number,
  fadeIn: number | undefined,
  fadeOut: number | undefined
): number {
  const { fadeIn: inSec, fadeOut: outSec } = normalizeFades(fadeIn, fadeOut, clipDuration)
  if (!Number.isFinite(elapsed)) return 1
  if (inSec > 0 && elapsed < inSec) {
    return Math.min(1, Math.max(0, elapsed / inSec))
  }
  if (outSec > 0 && elapsed > clipDuration - outSec) {
    const remaining = clipDuration - elapsed
    return Math.min(1, Math.max(0, remaining / outSec))
  }
  return 1
}

/**
 * 音声クリップが実際に鳴る長さ。本編の終わりより先に続く音(BGM など)は本編の終わりで切れるので、
 * フェードアウトもそこに掛ける(書き出しと同じ)。本編が無い・本編より後に始まる音は切らない
 */
export function audibleClipDuration(
  clipStart: number,
  clipDuration: number,
  timelineEnd: number
): number {
  if (!(timelineEnd > clipStart)) return clipDuration
  return Math.min(clipDuration, timelineEnd - clipStart)
}

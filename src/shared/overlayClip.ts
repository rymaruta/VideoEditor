/**
 * PiP(ワイプ)のクリップの速さ。未設定・0以下・数値でないときは等倍。
 *
 * ゲーム実況の顔カメラのワイプは、本編のクリップを速くした所でマイクの声と同じ速さで流す
 * (速さを持てなかった頃は、速くした区間のワイプが追従で落ち、書き出しは声だけで顔が消えていた)。
 */
export function overlayClipSpeed(clip: { speed?: number }): number {
  const s = clip.speed
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1
}

/**
 * PiP のクリップがタイムライン上で占める秒数(素材の秒数 ÷ 速さ)。
 * 素材の秒数(`outPoint - inPoint`)とは別物なので、尺を測るときは必ずこちらを使う
 * (プレビュー・タイムライン・書き出し・追従で別々に書くと、速くしたクリップの所だけ黙ってずれる)。
 */
export function overlayClipDuration(clip: {
  inPoint: number
  outPoint: number
  speed?: number
}): number {
  return (clip.outPoint - clip.inPoint) / overlayClipSpeed(clip)
}

/** PiP のクリップの終わり(タイムラインの秒) */
export function overlayClipEnd(clip: {
  startTime: number
  inPoint: number
  outPoint: number
  speed?: number
}): number {
  return clip.startTime + overlayClipDuration(clip)
}

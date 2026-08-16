import { toMediaTime } from './pendingPreviewLoad'

/**
 * プレビューの脇役(BGM・効果音・分離音声・PiP)を再生位置へ合わせる規則。
 *
 * これらは本編の `<video>` と違って**自分では位置を持たず**、再生位置から毎回計算した
 * 秒を書き込んで追従する。毎フレーム書き込むと `<audio>` が読み込み直しで音を飛ばすので、
 * 「ズレが大きいときだけ合わせ直す」という**許容**を置いてあった。
 *
 * ところがその許容は**ぼかし背景のために書かれた 0.3 秒**で、
 * *聞こえる* 音声クリップと *見える* PiP にもそのまま書き写されていた。結果、
 * **許容より小さくシークすると、その脇役だけ前の位置に取り残される**。
 * 本編は `seekRequest` を受けて必ずぴったり入れ直すので、**絵だけが動いて音が動かない**。
 * しかも一度ずれると、追従はズレが 0.3 秒を超えるまで何もしないので、
 * **そのまま再生してもズレたまま**最後まで進む。
 *
 * (実測・本編8秒 + BGM(素材0〜6秒を0秒に配置) + PiP: 4.0秒 → **4.25秒**へ動かすと
 *  本編は 0 秒ズレなのに BGM **-0.25秒** / PiP **-0.25秒**。2.29秒・2.79秒では
 *  **-0.29秒**。そのまま再生して1.5秒後も BGM **-0.232秒** / PiP **-0.227秒** と
 *  ズレたままだった。書き出しは同じ企画で BGM が**きっかり 2.000秒**から鳴る)
 *
 * 直し方は許容を小さくすることではない——**許容は連続再生の追従のためにあり、
 * 明示的なシークには要らない**。本編と同じように、シークのときだけぴったり入れる。
 */

/**
 * 連続再生中の追従で許すズレ(秒)。**ここを小さくして解決しない**こと
 * (毎フレーム書き込む形に近づき、音が飛ぶ)。
 */
export const PREVIEW_FOLLOW_TOLERANCE_SEC = 0.3

export interface PreviewTimedElement {
  currentTime: number
}

/**
 * 混ざった絵がそのまま見える層(クロスフェードで消えていく側)の許容。
 * ぼかし背景と違ってズレが直に見えるので、こちらは狭くしてある。
 */
export const PREVIEW_BLEND_FOLLOW_TOLERANCE_SEC = 0.12

/**
 * 連続再生中の追従。ズレが許容を超えたときだけ合わせ直す。
 * 入れる値は `toMediaTime` を通す(`currentTime` は `double` なので
 * NaN や ±Infinity を代入すると `TypeError` が飛ぶ)。
 */
export function followPreviewTime(
  el: PreviewTimedElement | null,
  targetTime: number,
  toleranceSec: number = PREVIEW_FOLLOW_TOLERANCE_SEC
): boolean {
  if (!el) return false
  const t = toMediaTime(targetTime)
  const tol = Number.isFinite(toleranceSec) && toleranceSec > 0 ? toleranceSec : 0
  if (Math.abs(el.currentTime - t) <= tol) return false
  el.currentTime = t
  return true
}

/**
 * 明示的なシーク。**許容を見ずに必ずぴったり入れる。**
 * 既に同じ値なら書かない(同じ値の代入でも `seeking` が飛んで音が途切れるため)。
 */
export function seekPreviewTime(el: PreviewTimedElement | null, targetTime: number): boolean {
  if (!el) return false
  const t = toMediaTime(targetTime)
  if (el.currentTime === t) return false
  el.currentTime = t
  return true
}

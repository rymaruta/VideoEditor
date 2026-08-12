/** PiPクリップとして残す最小の長さ(秒)。これ未満だとレーン上で掴めない */
export const MIN_PIP_DURATION = 0.5

/**
 * PiP(ワイプ)トラックに素材を置くときの、既定のアウト点を決める。
 *
 * PiP は本編に重ねるものなので、**本編が終わった後は書き出しに出ない**
 * (書き出しの `overlay` は `enable='between(t, 開始, 終了)'` で本編の上に乗せている)。
 * そのため「素材の全長」と「本編の残り尺」の小さい方を既定にする。
 * 全長そのままだと長い素材でレーンが極端に伸び、固定値(旧実装の5秒)だと
 * **短い素材でも必ず先頭5秒に切られて、伸ばし直す手間が毎回かかる**。
 *
 * @param assetDuration 素材の長さ(秒)
 * @param startTime PiPトラック上の配置開始位置(秒)
 * @param timelineDuration 本編の尺(秒)。0 なら本編が無い
 */
export function videoOverlayClipOutPoint(
  assetDuration: number,
  startTime: number,
  timelineDuration: number
): number {
  const asset = Number.isFinite(assetDuration) && assetDuration > 0 ? assetDuration : 0
  if (asset === 0) return 0
  const start = Number.isFinite(startTime) && startTime > 0 ? startTime : 0
  const timeline = Number.isFinite(timelineDuration) && timelineDuration > 0 ? timelineDuration : 0
  // 本編がまだ無いなら切る理由がないので全長を入れる
  if (timeline === 0) return asset
  const remaining = timeline - start
  // 本編の外に置かれる場合でも、掴める長さは残す(素材がそれより短ければ素材優先)
  return Math.min(asset, Math.max(remaining, MIN_PIP_DURATION))
}

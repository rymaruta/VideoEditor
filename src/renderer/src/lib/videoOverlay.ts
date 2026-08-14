import type { VideoOverlayClip } from '@shared/types'

/** PiPクリップとして残す最小の長さ(秒)。これ未満だとレーン上で掴めない */
export const MIN_PIP_DURATION = 0.5

/**
 * その時刻に映る PiP クリップを、**トラックの並び順のまま全部**返す。
 *
 * PiPレーンは重なりを禁じていない(好きな位置へ落とせるし、ドラッグでも重ねられる)。
 * 書き出しは `track.clips` を頭から1本ずつ `overlay` で重ねるので、
 * **重なった区間では後ろのクリップが上**に映る。プレビューが `find` で
 * 「最初に見つけた1本」だけを出していた頃は、同じ時刻で
 * **画面は先に置いたほう・書き出しは後に置いたほう**が映っていた。
 * (実測: 赤を0秒から・青を3秒から置いて 4.5秒を見ると、画面は赤、
 *  書き出しは青(V=111.7 / U=229.6)だった)
 *
 * 返す順は書き出しと同じ並び順。呼び出し側はこの順で重ねること
 * (絶対配置の兄弟要素は**後ろにあるものが上**に描かれるので、そのまま一致する)。
 */
export function activeVideoOverlayClips(
  clips: readonly VideoOverlayClip[],
  time: number
): VideoOverlayClip[] {
  return clips.filter((c) => {
    const duration = c.outPoint - c.inPoint
    // 尺0以下は書き出しも `dur <= 0` で読み飛ばすので、画面にも出さない。
    if (!(duration > 0)) return false
    return time >= c.startTime && time < c.startTime + duration
  })
}

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

import type { AspectRatio, MediaAsset, Project } from '@shared/types'

const MISMATCH_THRESHOLD = 0.15

export function isAspectMismatch(asset: MediaAsset, aspectRatio: AspectRatio): boolean {
  if (!asset.width || !asset.height) return false
  const assetRatio = asset.width / asset.height
  const targetRatio = aspectRatio === '9:16' ? 9 / 16 : 16 / 9
  return Math.abs(assetRatio - targetRatio) / targetRatio > MISMATCH_THRESHOLD
}

/**
 * 素材一覧に「縦横比が違うため、書き出しで黒帯が入ります」を出すか。
 * 黒帯が入るのは本編(V1)に置いて、クロップもぼかし背景もしていないときだけ。ワイプ(重ねる映像)は
 * 枠に収めて出すので黒帯は入らず、ワイプにしか使わない 4:3 の顔カメラにまで出ていた
 */
export function hasLetterboxInMain(
  asset: MediaAsset,
  project: Pick<Project, 'aspectRatio' | 'clips'>
): boolean {
  if (!asset.hasVideo || !isAspectMismatch(asset, project.aspectRatio)) return false
  return project.clips.some((c) => c.assetId === asset.id && !c.fillCrop && !c.blurBackground)
}

import type { AspectRatio, MediaAsset } from '@shared/types'

const MISMATCH_THRESHOLD = 0.15

export function isAspectMismatch(asset: MediaAsset, aspectRatio: AspectRatio): boolean {
  if (!asset.width || !asset.height) return false
  const assetRatio = asset.width / asset.height
  const targetRatio = aspectRatio === '9:16' ? 9 / 16 : 16 / 9
  return Math.abs(assetRatio - targetRatio) / targetRatio > MISMATCH_THRESHOLD
}

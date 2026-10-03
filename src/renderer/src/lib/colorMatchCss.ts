import type { MediaAsset } from '@shared/types'

/** 色合わせの SVG フィルタの id(`ColorMatchFilters` が作る) */
export function colorMatchFilterId(assetId: string): string {
  return `cm-${assetId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** `<video>` の CSS の filter に入れる値(補正が無ければ undefined) */
export function colorMatchCss(asset: MediaAsset | undefined | null): string | undefined {
  return asset?.colorMatch ? `url(#${colorMatchFilterId(asset.id)})` : undefined
}

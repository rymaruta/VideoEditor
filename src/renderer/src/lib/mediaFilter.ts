import { isImagePath } from '@shared/mediaExtensions'
import type { MediaAsset } from '@shared/types'

/** 素材の一覧の検索と種類(すべて / 動画 / 音声 / 画像)の絞り込み */

export type MediaKind = 'video' | 'audio' | 'image'
export type MediaKindFilter = 'all' | MediaKind

export const MEDIA_KIND_FILTERS: readonly { id: MediaKindFilter; label: string }[] = [
  { id: 'all', label: 'すべて' },
  { id: 'video', label: '動画' },
  { id: 'audio', label: '音声' },
  { id: 'image', label: '画像' }
]

/** 素材の種類。静止画(画像・版面 CG)は画像、絵のあるものは動画、それ以外は音声 */
export function assetKind(asset: Pick<MediaAsset, 'filePath' | 'hasVideo' | 'still'>): MediaKind {
  if (asset.still || isImagePath(asset.filePath)) return 'image'
  return asset.hasVideo ? 'video' : 'audio'
}

/** 比べやすい形(全角・半角、大文字・小文字をそろえる) */
function fold(s: string): string {
  return s.normalize('NFKC').toLowerCase()
}

/**
 * 検索の語(空白で区切ると全部を含むもの)と種類で絞る。並びは元のまま。
 * 当てるのはファイルの名前(置き場所のパスは当てない。どの素材にも当たる語が出るため)
 */
export function filterAssets<
  T extends Pick<MediaAsset, 'fileName' | 'filePath' | 'hasVideo' | 'still'>
>(assets: readonly T[], query: string, kind: MediaKindFilter): T[] {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  return assets.filter((a) => {
    if (kind !== 'all' && assetKind(a) !== kind) return false
    if (terms.length === 0) return true
    const hay = fold(a.fileName)
    return terms.every((t) => hay.includes(t))
  })
}

/** 種類ごとの数(絞り込みの札に出す) */
export function countByKind(
  assets: readonly Pick<MediaAsset, 'filePath' | 'hasVideo' | 'still'>[]
): Record<MediaKindFilter, number> {
  const out: Record<MediaKindFilter, number> = { all: assets.length, video: 0, audio: 0, image: 0 }
  for (const a of assets) out[assetKind(a)]++
  return out
}

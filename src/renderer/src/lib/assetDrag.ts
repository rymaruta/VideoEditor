/**
 * パネルからタイムラインへ引きずるときの `dataTransfer` の型名。
 *
 * 独自の型名にしてあるのは、**アプリ内のドラッグとOSからのファイルのドロップを取り違えない**ため。
 * ファイルのドロップは `Files` を含むので、両者は `types` を見るだけで区別できる。
 * ドラッグ中に読めるのは型名だけ(中身は drop のときだけ)なので、「置けるかどうか」は
 * 型名と、ストアに預けた素材から判定する。
 */
export const ASSET_DRAG_TYPE = 'application/x-ve-asset'

/** ソースビューアで決めたイン/アウト付きの素材。本編トラックだけが受ける */
export const SOURCE_RANGE_DRAG_TYPE = 'application/x-ve-source-range'

/** お気に入りの効果音。まだプロジェクトに無いファイルなので、パスを運ぶ */
export const SFX_DRAG_TYPE = 'application/x-ve-sfx'

export interface SourceRangeDragPayload {
  assetId: string
  inPoint: number
  outPoint: number
}

export interface SfxDragPayload {
  filePath: string
  fileName: string
}

export function isAssetDrag(types: readonly string[]): boolean {
  return types.includes(ASSET_DRAG_TYPE)
}

export function isSourceRangeDrag(types: readonly string[]): boolean {
  return types.includes(SOURCE_RANGE_DRAG_TYPE)
}

export function isSfxDrag(types: readonly string[]): boolean {
  return types.includes(SFX_DRAG_TYPE)
}

/** 壊れた JSON でドロップ側を落とさない(外から来た文字列として扱う) */
export function readDragPayload<T>(data: string): T | null {
  if (!data) return null
  try {
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

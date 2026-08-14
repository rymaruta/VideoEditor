/**
 * メディアパネルからタイムラインへ素材を引きずるときの `dataTransfer` の型名。
 *
 * 独自の型名にしてあるのは、**アプリ内のドラッグとOSからのファイルのドロップを取り違えない**ため。
 * ファイルのドロップは `Files` を含むので、両者は `types` を見るだけで区別できる。
 */
export const ASSET_DRAG_TYPE = 'application/x-ve-asset'

/** このドラッグがメディアパネルの素材か(ドラッグ中は中身を読めないので型名だけで判定する) */
export function isAssetDrag(types: readonly string[]): boolean {
  return types.includes(ASSET_DRAG_TYPE)
}

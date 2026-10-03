import type { MediaAsset } from '@shared/types'

/**
 * ファイルのパスを `file://` の URL にする。
 *
 * `encodeURI` は **`#` と `?` を残す**。どちらも URL では区切り記号なので、
 * `Hit #3.mp3` は `file:///…/Hit%20#3.mp3` になり、`#3` から先が**断片指定**として
 * 切り落とされて**そのファイルは読めない**(エラーは出ず、無言で鳴らない/映らない)。
 * 効果音ライブラリのファイル名は `\ / : * ? " < > |` しか伏せ字にしないので、
 * **`#` を含む名前はそのままここへ来る**(Freesound の「Hit #3」など)。
 * `encodeURI` の後ろでこの2つだけ追加で伏せる。
 */
export function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withSlash).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

/**
 * Which file the preview <video>/<audio> elements should load.
 *
 * Sources whose codec Chromium cannot decode (H.265/HEVC and friends) get a
 * transcoded H.264 proxy at import time; preview plays that, while export keeps
 * reading `filePath` so the output is never built from the downscaled copy.
 */
export function previewSourceUrl(asset: MediaAsset): string {
  return toFileUrl(previewSourcePath(asset))
}

/**
 * プレビューが実際に読むファイルの**パス**。
 *
 * 「再生できるか」を確かめる側は URL ではなくパスで受け取るので、
 * `proxyPath ?? filePath` の規則をそれぞれの場所に書き写さずここから取る。
 */
export function previewSourcePath(asset: MediaAsset): string {
  // 静止画は元の画像をそのまま見せる(プレビュー用の変換は動画のためのもの)
  if (asset.still) return asset.filePath
  return asset.proxyPath ?? asset.filePath
}

import type { MediaAsset } from '@shared/types'

export function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withSlash)}`
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
  return asset.proxyPath ?? asset.filePath
}

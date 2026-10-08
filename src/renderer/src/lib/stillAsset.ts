import { v4 as uuid } from 'uuid'
import { STILL_DURATION_SEC } from '@shared/mediaExtensions'
import type { MediaAsset } from '@shared/types'

/**
 * 静止画(PNG など)を素材にする。大きさは ffprobe で測り、長さは十分長くとる(置いたクリップで決める)。
 * 大きさが測れない画像(動く WebP・途中で切れた画像)は取り込まない。プレビューでは見えても、
 * 書き出しの ffmpeg が画を読めずに止まらなくなっていた
 */
export async function stillAssetFrom(filePath: string): Promise<MediaAsset> {
  const meta = await window.api.probeMedia(filePath).catch(() => null)
  if (!meta || !(meta.width > 0) || !(meta.height > 0))
    throw new Error('静止画として読めません(動く画像・壊れた画像は使えません)')
  let thumbnailDataUrl: string | undefined
  try {
    thumbnailDataUrl = await window.api.generateThumbnail(filePath, 0)
  } catch {
    thumbnailDataUrl = undefined
  }
  return {
    id: uuid(),
    filePath,
    fileName: filePath.split(/[/\\]/).pop() ?? filePath,
    duration: STILL_DURATION_SEC,
    width: meta.width,
    height: meta.height,
    fps: 30,
    hasAudio: false,
    hasVideo: true,
    still: true,
    thumbnailDataUrl
  }
}

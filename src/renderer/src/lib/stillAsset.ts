import { v4 as uuid } from 'uuid'
import { STILL_DURATION_SEC } from '@shared/mediaExtensions'
import type { MediaAsset } from '@shared/types'

/** 静止画(PNG など)を素材にする。大きさは ffprobe で測り、長さは十分長くとる(置いたクリップで決める) */
export async function stillAssetFrom(filePath: string): Promise<MediaAsset> {
  const meta = await window.api.probeMedia(filePath).catch(() => null)
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
    width: meta?.width ?? 0,
    height: meta?.height ?? 0,
    fps: 30,
    hasAudio: false,
    hasVideo: true,
    still: true,
    thumbnailDataUrl
  }
}

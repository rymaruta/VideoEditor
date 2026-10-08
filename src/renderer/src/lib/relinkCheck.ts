import { isImagePath } from '@shared/mediaExtensions'
import type { Project } from '@shared/types'

/**
 * つなぎ直せないなら、その理由(つなぎ直せるなら null)。
 *
 * 本編・ワイプで映像として使っている素材を、映像の無いファイル(音声だけ)につなぎ直すと、
 * 標準の書き出しは失敗し、長尺向けの書き出しは黒い画で書き出して、2つの書き出しが食い違っていた。
 * 本編のクリップを静止画につなぎ直すと、素材の途中から読む本編が1枚も画を出せずに書き出しが失敗していた
 * (本編へは静止画を置けない。タイムラインも置かせない)
 */
export function relinkRefusal(
  project: Pick<Project, 'clips' | 'videoOverlayTracks'>,
  assetId: string,
  filePath: string,
  probe: { hasVideo: boolean }
): string | null {
  const onMain = project.clips.some((c) => c.assetId === assetId)
  const onOverlay = project.videoOverlayTracks.some((t) =>
    t.clips.some((c) => c.assetId === assetId)
  )
  if (onMain && isImagePath(filePath))
    return '本編で使っている素材は、静止画につなぎ直せません。動画ファイルを選んでください'
  if ((onMain || onOverlay) && !probe.hasVideo && !isImagePath(filePath))
    return '映像として使っている素材は、映像の無いファイル(音声だけのファイル)につなぎ直せません'
  return null
}

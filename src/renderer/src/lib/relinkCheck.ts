import { isImagePath } from '@shared/mediaExtensions'
import type { MediaAsset, Project } from '@shared/types'

/**
 * つなぎ直せないなら、その理由(つなぎ直せるなら null)。
 *
 * 本編・ワイプで映像として使っている素材を、映像の無いファイル(音声だけ)につなぎ直すと、
 * 標準の書き出しは失敗し、長尺向けの書き出しは黒い画で書き出して、2つの書き出しが食い違っていた。
 * 本編のクリップを静止画につなぎ直すと、素材の途中から読む本編が1枚も画を出せずに書き出しが失敗していた
 * (本編へは静止画を置けない。タイムラインも置かせない)。同期したカメラは、今は本編に無くても
 * アングルを替えると本編に入るので、本編と同じに扱う。
 * 音声トラックで鳴らしている素材(BGM・ピンマイク・分離した音)を、音の無いファイルにつなぎ直すと、
 * 標準の書き出しは失敗し、長尺向けの書き出しは黙って音を落としていた
 */
export function relinkRefusal(
  project: Pick<Project, 'clips' | 'videoOverlayTracks'> &
    Partial<Pick<Project, 'audioTracks' | 'multicam'>>,
  assetId: string,
  filePath: string,
  probe: { hasVideo: boolean; hasAudio?: boolean }
): string | null {
  const image = isImagePath(filePath)
  const camera = project.multicam?.files.some(
    (f) =>
      f.assetId === assetId &&
      project.multicam?.sources.find((s) => s.id === f.sourceId)?.kind === 'camera'
  )
  const onMain = camera || project.clips.some((c) => c.assetId === assetId)
  const onOverlay = project.videoOverlayTracks.some((t) =>
    t.clips.some((c) => c.assetId === assetId)
  )
  // 同期したマイク・音声の素材は、今は音声トラックに無くても、仮編集を作り直すと戻ってくる
  const syncedSound = project.multicam?.files.some(
    (f) =>
      f.assetId === assetId &&
      project.multicam?.sources.find((s) => s.id === f.sourceId)?.kind !== 'camera'
  )
  const audible =
    syncedSound ||
    (project.audioTracks ?? []).some((t) => t.clips.some((c) => c.assetId === assetId))
  if (onMain && image)
    return '本編で使っている素材は、静止画につなぎ直せません。動画ファイルを選んでください'
  if ((onMain || onOverlay) && !probe.hasVideo && !image)
    return '映像として使っている素材は、映像の無いファイル(音声だけのファイル)につなぎ直せません'
  if (audible && (image || probe.hasAudio === false))
    return '音として使っている素材は、音の無いファイルにつなぎ直せません'
  return null
}

/** 本編に置ける素材か(映像があり、静止画でない)。アングルを替える先にも使う */
export function playableOnMain(asset: MediaAsset | undefined): boolean {
  return Boolean(asset && asset.hasVideo && !asset.still)
}

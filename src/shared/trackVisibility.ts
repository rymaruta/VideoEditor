import type { Project } from './types'

/**
 * 本編(V1)とテロップ(T1)の「目」(表示)。Premiere と同じく、隠したトラックは画面にも
 * 書き出しにも出さない。
 *
 * - V1 を隠す: 本編の**絵**だけを黒にする(本編の音は鳴らす。ワイプ・テロップは上に重なる)。
 *   標準の書き出しは本編を組んだ後に黒で塗り、区間ごとの書き出しは v2 の本編のトラックを
 *   隠したもの(`hidden`)として黒の隙間で組む
 * - T1 を隠す: テロップを 1 枚も焼き込まない(SRT・Premiere 用のテロップも出さない)
 *
 * 書き出しの入口(画面のテロップの層づくり・main の書き出し)は、必ず `projectForOutput` を通す。
 */
export function projectForOutput<T extends Pick<Project, 'textOverlays'> & TrackVisibility>(
  project: T
): T {
  if (project.telopTrackHidden !== true) return project
  return { ...project, textOverlays: [] }
}

export interface TrackVisibility {
  /** 本編(V1)の絵を出さない */
  mainVideoHidden?: boolean
  /** テロップ(T1)を出さない */
  telopTrackHidden?: boolean
}

/** 標準の書き出しで、組み上がった本編の絵を黒で塗る ffmpeg のフィルタ(大きさ・時刻はそのまま) */
export const HIDE_MAIN_VIDEO_FILTER = 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill'

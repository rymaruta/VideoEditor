import { frameCountForDuration } from './frameRate'
import { effectiveTransitionSeconds, type TransitionSpec } from './transition'

/**
 * 本編トラック(v1 の `Project.clips`)を**書き出しの中で**どこへ置くか。
 *
 * これまで書き出し(`ffmpegService`)の中でフィルタグラフを組みながら同時に数えていた値を、
 * 単体で確かめられる純関数として切り出したもの。データモデル v2 への移行
 * (`sequence/fromV1`)も**同じ関数**から位置を取るので、移行した結果と今の書き出しの
 * 位置が黙ってズレることはない。
 *
 * 数え方の理由(フレームに丸める・書き出し側の尺で畳み込む)は、書き出し側の
 * コメントに実測付きで残してある。ここではそれを1箇所にまとめただけで、値は1つも変えない。
 */
export interface MainTrackClipInput {
  inPoint: number
  outPoint: number
  speed?: number
  transitionIn?: TransitionSpec | null
}

export interface MainTrackLayout {
  /** タイムライン(画面)の上での1本の長さ(秒)。テロップ・BGM の位置はこの秒で来る */
  timelineDurations: number[]
  /** タイムライン上で各クリップが始まる秒(前から詰めて並べたもの。丸めない) */
  timelineStarts: number[]
  /** 書き出しの中での1本の長さ(秒)。フレーム数から作り直した値 */
  exportDurations: number[]
  /** 各クリップの手前に実際に掛かる繋ぎの秒数(先頭は必ず 0) */
  transitionSeconds: number[]
  /** 各クリップが書き出しの中で始まる秒(繋ぎのぶん手前と重なる) */
  exportStarts: number[]
  /**
   * 各クリップが書き出しの中で終わる秒。畳み込みの累積そのもので、繋ぎの無い次のクリップの
   * 始まりと**同じ数**になる(`始まり + 尺` を別に足すと小数の誤差で一致しないことがある)
   */
  exportEnds: number[]
  /** 書き出した本編の尺(秒) */
  totalExportDuration: number
}

export function computeMainTrackLayout(
  clips: readonly MainTrackClipInput[],
  outputFps: number
): MainTrackLayout {
  const timelineDurations = clips.map((c) => (c.outPoint - c.inPoint) / (c.speed || 1))
  // 1本ずつ尺をフレームに丸めると、丸めの差が本数ぶん積み上がり、書き出しがタイムラインより
  // 短く・長くなっていた(1.016 秒 × 20 本で 10 フレーム、自動編集の 88 本で 116ms 短く、終わりほど
  // 絵と音がタイムラインの位置より早く出た)。タイムラインでの終わりの時刻を丸め、その差を尺にする
  // (どの境目もタイムラインから半フレーム以内に収まる)
  const exportDurations: number[] = []
  {
    let acc = 0
    let prevFrames = 0
    for (const d of timelineDurations) {
      acc += Number.isFinite(d) && d > 0 ? d : 0
      const frames = frameCountForDuration(acc, outputFps)
      exportDurations.push(Math.max(0, frames - prevFrames) / outputFps)
      prevFrames = Math.max(prevFrames, frames)
    }
  }
  const timelineStarts: number[] = []
  {
    let acc = 0
    for (const d of timelineDurations) {
      timelineStarts.push(acc)
      acc += d
    }
  }
  const transitionSeconds = effectiveTransitionSeconds(
    exportDurations,
    clips.map((c) => c.transitionIn)
  )
  const exportStarts: number[] = new Array(clips.length).fill(0)
  const exportEnds: number[] = new Array(clips.length).fill(0)
  let curDuration = clips.length > 0 ? exportDurations[0] : 0
  if (clips.length > 0) exportEnds[0] = curDuration
  for (let i = 1; i < clips.length; i++) {
    const t = transitionSeconds[i]
    if (t <= 0 || !clips[i].transitionIn) {
      exportStarts[i] = curDuration
      curDuration = curDuration + exportDurations[i]
    } else {
      exportStarts[i] = Math.max(0, curDuration - t)
      curDuration = curDuration + exportDurations[i] - t
    }
    exportEnds[i] = curDuration
  }
  return {
    timelineDurations,
    timelineStarts,
    exportDurations,
    transitionSeconds,
    exportStarts,
    exportEnds,
    totalExportDuration: curDuration
  }
}

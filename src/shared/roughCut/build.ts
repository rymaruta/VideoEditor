import { fileAt, toSource, type MulticamInfo } from '../sync/multicam'
import type { Shot } from '../angles/choose'

/**
 * 仮編集(構成 → カット → アングル)をタイムラインの中身にする。
 *
 * - 本編: ショットごとに、そのカメラの素材の該当部分を並べる(素材の切れ目ではクリップを分ける)。
 *   本編のカメラの音は使わない(カメラを替えるたびに音質が跳ねるため)
 * - 声: ピンマイクごとの音声トラックに、本編と同じ区間を並べる
 * - 周りの音: 基準カメラの音を別の音声トラックに小さめに流す(ピンマイクだけだと場の空気が消える)
 *
 * 続いている区間(カメラの切り替えだけで時間は飛んでいない)は、音声を1本のクリップにまとめる。
 * 時刻は共通の時間軸(基準カメラの時計)、素材の時刻への換算は `MulticamInfo` の start / rate。
 */

export interface RoughMainClip {
  assetId: string
  inPoint: number
  outPoint: number
  speed: number
}

export interface RoughAudioClip {
  assetId: string
  startTime: number
  inPoint: number
  outPoint: number
  speed: number
}

export interface RoughCut {
  main: RoughMainClip[]
  /** マイク(と周りの音)ごとの音声トラック */
  audio: { name: string; sourceId: string; volume: number; clips: RoughAudioClip[] }[]
  /** タイムラインの長さ(秒) */
  duration: number
  /** 仮編集のタイムラインの時刻 ↔ 共通の時刻 の対応(テロップを置くのに使う) */
  spans: { timeline: number; start: number; end: number }[]
}

/** 周りの音(基準カメラの音)の音量 */
export const AMBIENCE_VOLUME = 0.35

export function buildRoughCut(
  shots: readonly Shot[],
  info: MulticamInfo,
  options: { ambienceVolume?: number } = {}
): RoughCut {
  const main: RoughMainClip[] = []
  // 本編: ショットを素材の切れ目で分けて並べる
  const placed: { start: number; end: number }[] = []
  for (const s of shots) {
    let t = s.start
    while (t < s.end - 1e-6) {
      const f = fileAt(info, s.cameraId, t)
      if (!f) break
      const end = Math.min(s.end, f.start + f.duration / f.rate)
      main.push({
        assetId: f.assetId,
        inPoint: toSource(f, t),
        outPoint: toSource(f, end),
        speed: f.rate
      })
      placed.push({ start: t, end })
      t = end
    }
  }

  // 本編に並んだ区間を、時間の続いているものどうしでまとめる
  const spans: RoughCut['spans'] = []
  let timeline = 0
  for (const p of placed) {
    const last = spans[spans.length - 1]
    if (last && Math.abs(last.end - p.start) < 1e-6) last.end = p.end
    else spans.push({ timeline, start: p.start, end: p.end })
    timeline += p.end - p.start
  }

  const audioFor = (sourceId: string): RoughAudioClip[] => {
    const clips: RoughAudioClip[] = []
    for (const span of spans) {
      let t = span.start
      while (t < span.end - 1e-6) {
        const f = fileAt(info, sourceId, t)
        if (!f) {
          // この機材が録っていない時間は飛ばす(次に録っている所から)
          const next = info.files
            .filter((x) => x.sourceId === sourceId && x.start > t)
            .reduce((m, x) => Math.min(m, x.start), Infinity)
          t = Math.min(span.end, next)
          continue
        }
        const end = Math.min(span.end, f.start + f.duration / f.rate)
        clips.push({
          assetId: f.assetId,
          startTime: span.timeline + (t - span.start),
          inPoint: toSource(f, t),
          outPoint: toSource(f, end),
          speed: f.rate
        })
        t = end
      }
    }
    return clips
  }

  const mics = info.sources.filter((s) => s.kind === 'mic')
  const audio: RoughCut['audio'] = mics.map((m) => ({
    name: m.name,
    sourceId: m.id,
    volume: 1,
    clips: audioFor(m.id)
  }))
  const anchor = info.sources.find((s) => s.id === info.anchorSourceId)
  if (anchor) {
    audio.push({
      // ピンマイクが無ければ、基準カメラの音が声も兼ねるので小さくしない
      name: mics.length > 0 ? `周りの音(${anchor.name})` : `${anchor.name} の音`,
      sourceId: anchor.id,
      volume: mics.length > 0 ? (options.ambienceVolume ?? AMBIENCE_VOLUME) : 1,
      clips: audioFor(anchor.id)
    })
  }
  return { main, audio, duration: timeline, spans }
}

/** 共通の時刻 → 仮編集のタイムラインの時刻(使っていない時間なら null) */
export function roughTimelineAt(spans: RoughCut['spans'], t: number): number | null {
  for (const s of spans) if (t >= s.start - 1e-6 && t < s.end) return s.timeline + (t - s.start)
  return null
}

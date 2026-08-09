import type { Clip, MediaAsset, Project } from '@shared/types'

export interface TimedClip {
  clip: Clip
  asset: MediaAsset
  start: number
  end: number
}

export function buildTimedClips(project: Project): TimedClip[] {
  const assetById = new Map(project.assets.map((a) => [a.id, a]))
  let cursor = 0
  const result: TimedClip[] = []
  for (const clip of project.clips) {
    const asset = assetById.get(clip.assetId)
    if (!asset) continue
    const duration = (clip.outPoint - clip.inPoint) / (clip.speed || 1)
    result.push({ clip, asset, start: cursor, end: cursor + duration })
    cursor += duration
  }
  return result
}

export function findTimedClipAt(timedClips: TimedClip[], time: number): TimedClip | null {
  for (const tc of timedClips) {
    if (time >= tc.start && time < tc.end) return tc
  }
  return timedClips.length > 0 ? timedClips[timedClips.length - 1] : null
}

export function totalTimelineDuration(timedClips: TimedClip[]): number {
  return timedClips.length === 0 ? 0 : timedClips[timedClips.length - 1].end
}

/**
 * 音声クリップがタイムライン上で占める秒数。速度を掛けたぶん短く(長く)なる。
 * 素材の秒数(`outPoint - inPoint`)とは別物なので、尺を測るときは必ずこちらを使う。
 */
export function audioClipDuration(clip: {
  inPoint: number
  outPoint: number
  speed?: number
}): number {
  return (clip.outPoint - clip.inPoint) / (clip.speed || 1)
}

/**
 * 音声トラックに `duration` 秒のクリップを `desiredStart` から置きたいとき、既存クリップと
 * 重ならない最初の位置を返す。
 *
 * 重ねて置かないのは、音声クリップが `startTime` で絶対配置されるため。同じ時刻に同じ尺の
 * クリップを重ねると後から置いた方が前を完全に覆い、**覆われた方は画面から見えず選択も
 * 削除もできないのに音だけ二重に鳴る**。ワンクリックで足せるUIでは事故になる。
 * 重ねたい場合は、置いたあとに手でドラッグして動かせる。
 */
export function findFreeAudioStart(
  existing: { startTime: number; inPoint: number; outPoint: number; speed?: number }[],
  desiredStart: number,
  duration: number
): number {
  let start = Number.isFinite(desiredStart) ? Math.max(0, desiredStart) : 0
  if (!Number.isFinite(duration) || duration <= 0) return start
  const occupied = existing
    .map((c) => ({ start: c.startTime, end: c.startTime + audioClipDuration(c) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start)
  // 前から順に見て、ぶつかるたびにその相手の直後へ逃がす。開始順に並べてあるので、
  // 一度で通り抜けたところが最初の空き。
  for (const range of occupied) {
    if (range.start < start + duration && range.end > start) start = range.end
  }
  return start
}

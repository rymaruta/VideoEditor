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
    const duration = clip.outPoint - clip.inPoint
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

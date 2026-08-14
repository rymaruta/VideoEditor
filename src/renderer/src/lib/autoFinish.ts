import { useProjectStore } from '../store/projectStore'
import { buildTimedClips, totalTimelineDuration } from './timelineMath'
import { captureAiFrames } from './aiFrames'
import { defaultTextStyle } from '@shared/textStyle'
import { generateVideoMetadata, type VideoMetadata } from './metadataGeneration'
import type { TextOverlay } from '@shared/types'

export interface AutoFinishResult {
  captionCount: number
  metadata: VideoMetadata | null
}

export async function autoFinishTimeline(
  geminiApiKey: string | undefined,
  language: string
): Promise<AutoFinishResult> {
  const store = useProjectStore.getState()
  const timedClips = buildTimedClips(store.project)

  const overlays: Omit<TextOverlay, 'id'>[] = []
  for (const tc of timedClips) {
    if (!tc.asset.hasAudio) continue
    try {
      const segments = await window.api.transcribe(
        tc.asset.filePath,
        tc.clip.inPoint,
        tc.clip.outPoint,
        language
      )
      const speed = tc.clip.speed || 1
      for (const seg of segments) {
        const text = seg.text.trim()
        if (!text) continue
        const startTime = tc.start + (seg.start - tc.clip.inPoint) / speed
        const endTime = tc.start + (seg.end - tc.clip.inPoint) / speed
        overlays.push({
          text,
          startTime,
          endTime,
          style: defaultTextStyle(),
          source: 'auto'
        })
      }
    } catch {
      // Skip clips whose transcription fails; continue with the rest.
    }
  }
  store.addTextOverlays(overlays)
  const captionCount = overlays.length

  let metadata: VideoMetadata | null = null
  if (geminiApiKey) {
    try {
      const latestProject = useProjectStore.getState().project
      const transcript = latestProject.textOverlays
        .slice()
        .sort((a, b) => a.startTime - b.startTime)
        .map((o) => o.text)
        .join('\n')
      const total = totalTimelineDuration(timedClips)
      const frames = await captureAiFrames(timedClips, total, latestProject.aspectRatio)
      metadata = await generateVideoMetadata(geminiApiKey, transcript, '', language, frames)
    } catch {
      // Metadata generation is best-effort; the captions added above are still kept.
    }
  }

  return { captionCount, metadata }
}

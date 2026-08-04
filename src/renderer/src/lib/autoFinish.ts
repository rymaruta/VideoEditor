import { useProjectStore } from '../store/projectStore'
import { buildTimedClips, totalTimelineDuration, findTimedClipAt } from './timelineMath'
import { defaultTextStyle } from '@shared/textStyle'
import { generateVideoMetadata, type VideoMetadata } from './metadataGeneration'

const FRAME_FRACTIONS = [0.15, 0.5, 0.85]
const FRAME_WIDTH = 320
const FRAME_HEIGHT = 568

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

  let captionCount = 0
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
        store.addTextOverlay({
          text,
          startTime,
          endTime,
          style: defaultTextStyle(),
          source: 'auto'
        })
        captionCount++
      }
    } catch {
      // Skip clips whose transcription fails; continue with the rest.
    }
  }

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
      const frames: string[] = []
      for (const fraction of FRAME_FRACTIONS) {
        const globalTime = Math.min(total - 0.05, total * fraction)
        const tc = findTimedClipAt(timedClips, globalTime)
        if (!tc || !tc.asset.hasVideo) continue
        const speed = tc.clip.speed || 1
        const localTime = tc.clip.inPoint + (globalTime - tc.start) * speed
        try {
          frames.push(
            await window.api.generateFrame(tc.asset.filePath, localTime, FRAME_WIDTH, FRAME_HEIGHT)
          )
        } catch {
          // Skip frames that fail to extract (e.g. right at a clip boundary).
        }
      }
      metadata = await generateVideoMetadata(geminiApiKey, transcript, '', language, frames)
    } catch {
      // Metadata generation is best-effort; the captions added above are still kept.
    }
  }

  return { captionCount, metadata }
}

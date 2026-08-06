import { detectAudioLevels } from './highlightService'
import type { LongFormWindow } from '@shared/types'

/**
 * Finds the most energetic stretches of a long recording using audio only.
 *
 * Deliberately never decodes video. Measured on 1080p HEVC, scene detection costs
 * ~6s per minute of footage versus ~0.18s for an audio-only pass — 12 minutes versus
 * 21 seconds for a two-hour recording. Everything expensive (scene detection,
 * transcription, an LLM) is reserved for the handful of windows this returns.
 */

const WINDOW_LEAD_IN = 2
const WINDOW_TAIL = 3
const MIN_WINDOW = 8
const MAX_WINDOW = 22
// Peaks closer together than this belong to the same moment, not two separate ones.
const PEAK_GAP = 2

export function buildWindowsFromLevels(
  levels: { time: number; rmsDb: number }[],
  duration: number,
  maxWindows: number
): LongFormWindow[] {
  const finite = levels.filter((l) => Number.isFinite(l.rmsDb) && l.rmsDb > -90)
  if (finite.length === 0) return []
  const mean = finite.reduce((sum, l) => sum + l.rmsDb, 0) / finite.length
  const variance = finite.reduce((sum, l) => sum + (l.rmsDb - mean) ** 2, 0) / finite.length
  const stddev = Math.sqrt(variance)
  // A fixed dB threshold fails across recordings with different mastering; scoring
  // relative to the recording's own loudness keeps this comparable between sources.
  const threshold = mean + Math.max(2, stddev * 0.8)

  interface Group {
    start: number
    end: number
    intensity: number
  }
  const groups: Group[] = []
  for (const frame of finite) {
    if (frame.rmsDb <= threshold) continue
    const intensity = (frame.rmsDb - mean) / (stddev || 1)
    const last = groups[groups.length - 1]
    if (last && frame.time <= last.end + PEAK_GAP) {
      last.end = frame.time
      last.intensity += intensity
    } else {
      groups.push({ start: frame.time, end: frame.time, intensity })
    }
  }

  const windows = groups.map((g) => {
    const start = Math.max(0, g.start - WINDOW_LEAD_IN)
    let end = Math.min(duration, Math.max(g.end + WINDOW_TAIL, start + MIN_WINDOW))
    if (end - start > MAX_WINDOW) end = start + MAX_WINDOW
    return { start, end, score: g.intensity }
  })

  // Pick greedily by score but skip anything overlapping an already-chosen window, so
  // the shortlist spans the recording instead of clustering on one loud passage.
  const chosen: LongFormWindow[] = []
  for (const w of [...windows].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= maxWindows) break
    if (chosen.some((c) => w.start < c.end && w.end > c.start)) continue
    chosen.push(w)
  }
  return chosen.sort((a, b) => a.start - b.start)
}

export async function scanLongFormWindows(
  filePath: string,
  duration: number,
  maxWindows: number
): Promise<LongFormWindow[]> {
  const levels = await detectAudioLevels(filePath)
  return buildWindowsFromLevels(levels, duration, maxWindows)
}

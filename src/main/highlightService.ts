import { spawn } from 'child_process'
import { ffmpegPath } from './ffmpegService'
import type { HighlightCandidate, ReferenceStyleAnalysis } from '@shared/types'

function runFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => (stdout += chunk.toString()))
    proc.stderr.on('data', (chunk) => (stderr += chunk.toString()))
    proc.on('error', reject)
    proc.on('close', () => resolve({ stdout, stderr }))
  })
}

export async function detectSceneChanges(filePath: string): Promise<number[]> {
  const { stderr } = await runFfmpeg([
    '-i',
    filePath,
    '-vf',
    "select='gt(scene,0.3)',showinfo",
    '-f',
    'null',
    '-'
  ])
  const times: number[] = []
  const regex = /pts_time:([\d.]+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(stderr))) {
    times.push(Number(match[1]))
  }
  return times
}

interface AudioLevel {
  time: number
  rmsDb: number
}

async function detectAudioLevels(filePath: string): Promise<AudioLevel[]> {
  const { stdout } = await runFfmpeg([
    '-i',
    filePath,
    '-af',
    'asetnsamples=n=44100,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f',
    'null',
    '-'
  ])
  const levels: AudioLevel[] = []
  const lines = stdout.split('\n')
  let pendingTime: number | null = null
  for (const line of lines) {
    const timeMatch = /pts_time:([\d.]+)/.exec(line)
    if (timeMatch) {
      pendingTime = Number(timeMatch[1])
      continue
    }
    const rmsMatch = /RMS_level=(-?[\d.]+)/.exec(line)
    if (rmsMatch && pendingTime !== null) {
      const rms = Number(rmsMatch[1])
      if (Number.isFinite(rms)) levels.push({ time: pendingTime, rmsDb: rms })
      pendingTime = null
    }
  }
  return levels
}

const CANDIDATE_LEAD_IN = 1
const CANDIDATE_TAIL = 3
const ADJACENT_PEAK_GAP = 1.5
const SCENE_MATCH_WINDOW = 2

export async function detectHighlights(
  filePath: string,
  assetDuration: number
): Promise<HighlightCandidate[]> {
  const [sceneTimes, audioLevels] = await Promise.all([
    detectSceneChanges(filePath),
    detectAudioLevels(filePath)
  ])

  const finiteLevels = audioLevels.filter((l) => l.rmsDb > -90)
  const mean =
    finiteLevels.length > 0
      ? finiteLevels.reduce((sum, l) => sum + l.rmsDb, 0) / finiteLevels.length
      : -50
  const variance =
    finiteLevels.length > 0
      ? finiteLevels.reduce((sum, l) => sum + (l.rmsDb - mean) ** 2, 0) / finiteLevels.length
      : 0
  const stddev = Math.sqrt(variance)
  const threshold = mean + Math.max(3, stddev)

  // Highlights are driven by loud/energetic audio moments; scene changes only
  // boost the score of a window they happen to fall within (cuts alone are too
  // frequent in ordinary footage to be a standalone "highlight" signal).
  const peakFrames = audioLevels.filter((l) => l.rmsDb > threshold)

  interface PeakGroup {
    start: number
    end: number
    intensity: number
  }
  const peakGroups: PeakGroup[] = []
  for (const frame of peakFrames) {
    const last = peakGroups[peakGroups.length - 1]
    const intensity = (frame.rmsDb - mean) / (stddev || 1)
    if (last && frame.time <= last.end + ADJACENT_PEAK_GAP) {
      last.end = frame.time
      last.intensity += intensity
    } else {
      peakGroups.push({ start: frame.time, end: frame.time, intensity })
    }
  }

  const candidates: HighlightCandidate[] = peakGroups.map((group) => {
    const start = Math.max(0, group.start - CANDIDATE_LEAD_IN)
    const end = Math.min(assetDuration, group.end + CANDIDATE_TAIL)
    const hasSceneChange = sceneTimes.some(
      (t) => t >= group.start - SCENE_MATCH_WINDOW && t <= group.end + SCENE_MATCH_WINDOW
    )
    return {
      start,
      end,
      score: group.intensity + (hasSceneChange ? 2 : 0),
      hasSceneChange,
      hasAudioPeak: true
    }
  })

  return candidates.sort((a, b) => b.score - a.score).slice(0, 12)
}

export async function analyzeReferenceStyle(filePath: string): Promise<ReferenceStyleAnalysis> {
  const cutTimes = await detectSceneChanges(filePath)
  return { cutTimes }
}

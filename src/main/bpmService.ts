import { spawn } from 'child_process'
import { ffmpegPath } from './ffmpegService'
import type { BpmAnalysisResult } from '@shared/types'

const SAMPLE_RATE = 22050
const FRAME_SIZE = 256
const MIN_BPM = 70
const MAX_BPM = 190
const MAX_ANALYZE_SECONDS = 60
const OCTAVE_SCORE_RATIO = 0.65

function decodePcm(filePath: string, start: number, duration: number): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const args = [
      '-ss',
      String(Math.max(0, start)),
      '-t',
      String(duration),
      '-i',
      filePath,
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-'
    ]
    const proc = spawn(ffmpegPath, args)
    const chunks: Buffer[] = []
    proc.stdout.on('data', (chunk) => chunks.push(chunk))
    proc.on('error', reject)
    proc.on('close', () => {
      const buf = Buffer.concat(chunks)
      const sampleCount = Math.floor(buf.length / 2)
      const samples = new Int16Array(sampleCount)
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = buf.readInt16LE(i * 2)
      }
      resolve(samples)
    })
  })
}

function computeBpm(samples: Int16Array): BpmAnalysisResult {
  const frameCount = Math.floor(samples.length / FRAME_SIZE)
  const energies = new Float64Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    let sum = 0
    const base = i * FRAME_SIZE
    for (let j = 0; j < FRAME_SIZE; j++) {
      const s = samples[base + j] / 32768
      sum += s * s
    }
    energies[i] = Math.sqrt(sum / FRAME_SIZE)
  }

  // Onset/flux envelope: emphasizes transients (note attacks, drum hits) rather
  // than raw loudness, which is a better signal to lock a tempo grid onto.
  const flux = new Float64Array(frameCount)
  for (let i = 1; i < frameCount; i++) {
    flux[i] = Math.max(0, energies[i] - energies[i - 1])
  }

  const frameRate = SAMPLE_RATE / FRAME_SIZE
  const minLag = Math.max(1, Math.round((60 / MAX_BPM) * frameRate))
  const maxLag = Math.round((60 / MIN_BPM) * frameRate)

  const fluxMean = flux.reduce((a, b) => a + b, 0) / (flux.length || 1)
  const centered = Float64Array.from(flux, (v) => v - fluxMean)

  const scoreByLag = new Map<number, number>()
  let bestLag = minLag
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    let count = 0
    for (let i = 0; i + lag < centered.length; i++) {
      sum += centered[i] * centered[i + lag]
      count++
    }
    const normalized = count > 0 ? sum / count : 0
    scoreByLag.set(lag, normalized)
    if (normalized > bestScore) {
      bestScore = normalized
      bestLag = lag
    }
  }

  // Autocorrelation of a periodic beat signal peaks at every integer multiple of
  // the true period, so the strongest peak can land on 2x/3x the real beat
  // interval (a classic "half-tempo" octave error). Prefer the fastest lag among
  // the winner and its divisors whose score is still comparably strong.
  const originalBestLag = bestLag
  const originalBestScore = bestScore
  let chosenLag = originalBestLag
  for (const divisor of [2, 3]) {
    for (const candidate of [
      Math.floor(originalBestLag / divisor),
      Math.ceil(originalBestLag / divisor)
    ]) {
      if (candidate < minLag || candidate >= chosenLag) continue
      const candidateScore = scoreByLag.get(candidate)
      if (
        candidateScore !== undefined &&
        candidateScore >= originalBestScore * OCTAVE_SCORE_RATIO
      ) {
        chosenLag = candidate
      }
    }
  }
  bestLag = chosenLag

  // Parabolic interpolation across the winning lag's neighbors for sub-frame precision.
  let refinedLag = bestLag
  const y0 = scoreByLag.get(bestLag - 1)
  const y1 = scoreByLag.get(bestLag)
  const y2 = scoreByLag.get(bestLag + 1)
  if (y0 !== undefined && y1 !== undefined && y2 !== undefined) {
    const denom = y0 - 2 * y1 + y2
    if (Math.abs(denom) > 1e-9) {
      const delta = (0.5 * (y0 - y2)) / denom
      if (Math.abs(delta) < 1) refinedLag = bestLag + delta
    }
  }

  const bpm = Math.round((60 * frameRate) / refinedLag)

  const scores = [...scoreByLag.values()]
  const avgScore = scores.reduce((a, b) => a + b, 0) / (scores.length || 1)
  const spread = scores.reduce((sum, s) => sum + Math.abs(s - avgScore), 0) / (scores.length || 1)
  const confidence =
    spread > 0 ? Math.min(1, Math.max(0, (bestScore - avgScore) / (spread * 4))) : 0

  let bestOffsetFrame = 0
  let bestOffsetScore = -Infinity
  for (let i = 0; i < Math.min(bestLag, flux.length); i++) {
    if (flux[i] > bestOffsetScore) {
      bestOffsetScore = flux[i]
      bestOffsetFrame = i
    }
  }

  return {
    bpm,
    confidence,
    offsetSeconds: bestOffsetFrame / frameRate
  }
}

export async function analyzeBpm(
  filePath: string,
  start: number,
  duration: number
): Promise<BpmAnalysisResult> {
  const clampedDuration = Math.min(duration, MAX_ANALYZE_SECONDS)
  if (clampedDuration < 2) {
    throw new Error('BPM解析には2秒以上の音声が必要です')
  }
  const samples = await decodePcm(filePath, start, clampedDuration)
  if (samples.length < SAMPLE_RATE * 2) {
    throw new Error('音声データを取得できませんでした')
  }
  return computeBpm(samples)
}

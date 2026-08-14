import { detectAudioLevels, measureVisualActivity } from './highlightService'
import { loudnessStats, STATS_FLOOR_DB } from '@shared/highlight'
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

// 映像を読む候補は、音で絞った上位のさらに数倍まで。ここを広げるほど選び直しの幅は
// 増えるが、デコードする区間もそのぶん増える。
const VISUAL_OVERSCAN = 2

export function buildWindowCandidates(
  levels: { time: number; rmsDb: number }[],
  duration: number
): LongFormWindow[] {
  const finite = levels.filter((l) => Number.isFinite(l.rmsDb) && l.rmsDb > STATS_FLOOR_DB)
  if (finite.length === 0) return []
  // 平均とばらつきは**ハイライト検出と同じ関数**から求める。ここで自前に数えていたころは
  // `-90dB` の絶対値でしか無音を外しておらず、**最大からの相対**で外す処理が入っていなかった。
  // 録画の頭や末尾に**デジタル無音ではない静か**(暗騒音)が数秒あるだけで、平均が下がり
  // ばらつきが跳ね上がり、しきい値が素材の最大音量を追い越して**1件も見つからなくなる**。
  // (実測: 33秒・地の声 -44.1dB・山 -41.0dB の録画で3件。頭の3秒だけを -85dB にすると
  //  ばらつきが 1.2 → 12.0、しきい値が -41.5 → -37.6 と山を追い越して **0件**になった)
  const { mean, stddev } = loudnessStats(finite.map((l) => l.rmsDb))
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

  return groups.map((g) => {
    const start = Math.max(0, g.start - WINDOW_LEAD_IN)
    let end = Math.min(duration, Math.max(g.end + WINDOW_TAIL, start + MIN_WINDOW))
    if (end - start > MAX_WINDOW) end = start + MAX_WINDOW
    return { start, end, score: g.intensity }
  })
}

/**
 * Pick greedily by score but skip anything overlapping an already-chosen window, so
 * the shortlist spans the recording instead of clustering on one loud passage.
 */
export function pickWindows(candidates: LongFormWindow[], maxWindows: number): LongFormWindow[] {
  const chosen: LongFormWindow[] = []
  for (const w of [...candidates].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= maxWindows) break
    if (chosen.some((c) => w.start < c.end && w.end > c.start)) continue
    chosen.push(w)
  }
  return chosen.sort((a, b) => a.start - b.start)
}

/**
 * 音量スコアと映像の変化量を混ぜ直す。
 *
 * 2つの尺度は単位がまるで違う(音量は z 値の積み上げ、映像は輝度差の平均)ので、
 * それぞれ**その回の最大値で割って 0〜1 に揃えてから**重み付けする。
 * 映像を測れなかった区間(`null`)は音量スコアだけで評価する — 0 として混ぜると、
 * キーフレームが疎なだけの区間が確実に落ちてしまう。
 */
export function blendVisualScores(
  windows: LongFormWindow[],
  visualChanges: (number | null)[],
  visualWeight: number
): LongFormWindow[] {
  const weight = Math.min(1, Math.max(0, visualWeight))
  if (!(weight > 0)) return windows
  const audioMax = Math.max(0, ...windows.map((w) => (Number.isFinite(w.score) ? w.score : 0)))
  const visualMax = Math.max(
    0,
    ...visualChanges.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
  )
  return windows.map((w, i) => {
    const audioNorm = audioMax > 0 && Number.isFinite(w.score) ? w.score / audioMax : 0
    const change = visualChanges[i]
    if (typeof change !== 'number' || !Number.isFinite(change) || visualMax <= 0) {
      return { ...w, score: audioNorm }
    }
    return { ...w, score: (1 - weight) * audioNorm + weight * (change / visualMax) }
  })
}

export function buildWindowsFromLevels(
  levels: { time: number; rmsDb: number }[],
  duration: number,
  maxWindows: number
): LongFormWindow[] {
  return pickWindows(buildWindowCandidates(levels, duration), maxWindows)
}

export async function scanLongFormWindows(
  filePath: string,
  duration: number,
  maxWindows: number,
  visualWeight = 0
): Promise<LongFormWindow[]> {
  const levels = await detectAudioLevels(filePath)
  const candidates = buildWindowCandidates(levels, duration)
  if (!(visualWeight > 0)) return pickWindows(candidates, maxWindows)

  // 映像を読むのは、音で絞ったこの数件だけ。素材全体はデコードしない。
  const shortlist = pickWindows(candidates, maxWindows * VISUAL_OVERSCAN)
  const changes = await measureVisualActivity(filePath, shortlist)
  return pickWindows(blendVisualScores(shortlist, changes, visualWeight), maxWindows)
}

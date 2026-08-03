export interface SnapResult {
  time: number
  snapped: boolean
}

export function snapTime(
  rawTime: number,
  candidates: number[],
  thresholdSeconds: number
): SnapResult {
  let best: number | null = null
  let bestDist = thresholdSeconds
  for (const c of candidates) {
    const d = Math.abs(c - rawTime)
    if (d <= bestDist) {
      bestDist = d
      best = c
    }
  }
  if (best !== null) return { time: best, snapped: true }
  return { time: rawTime, snapped: false }
}

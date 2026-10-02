/**
 * タイムラインの時間目盛り(上端のルーラー)。Premiere と同じ `時:分:秒:フレーム` で出す。
 *
 * 目盛りの間隔はズームに合わせて選ぶ(数字同士が重ならない最小の間隔)。描くのは見えている
 * 範囲だけ(長尺でも目盛りの数が一定になるように)。
 */

/** 選べる間隔(秒)。1フレーム単位は fps から足す */
const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/** 目盛りの数字同士の最小の間隔(画素) */
export const RULER_MIN_SPACING_PX = 90

export function rulerStep(
  pixelsPerSecond: number,
  fps: number,
  minSpacingPx = RULER_MIN_SPACING_PX
): number {
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return 3600
  const frame = Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 30
  const candidates = [frame, frame * 5, frame * 10, ...STEPS]
  return candidates.find((s) => s * pixelsPerSecond >= minSpacingPx) ?? STEPS[STEPS.length - 1]
}

/** [from, to] 秒に入る目盛りの時刻(間隔の整数倍)。数が多すぎるときは打ち切る */
export function rulerTicks(from: number, to: number, step: number, max = 400): number[] {
  if (!(step > 0) || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return []
  const out: number[] = []
  const first = Math.max(0, Math.ceil(from / step - 1e-9))
  for (let i = first; i * step <= to + 1e-9 && out.length < max; i++) out.push(i * step)
  return out
}

/** `時:分:秒:フレーム`。負や数でない値は 0 として扱う */
export function formatTimecode(seconds: number, fps: number): string {
  const rate = Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 30
  // 99時間で頭打ちにする(壊れた値で表示が Infinity にならないように)
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 99 * 3600) : 0
  const total = Math.round(safe * rate)
  const f = total % rate
  const s = Math.floor(total / rate)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`
}

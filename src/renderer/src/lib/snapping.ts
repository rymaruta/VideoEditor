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

/**
 * スナップしたうえで、許される範囲に収める。
 *
 * `snapTime` が返すのは**候補の時刻そのもの**なので、呼ぶ前にいくらクランプしていても
 * スナップで範囲の外へ出る。呼ぶ側で「クランプ → スナップ」の順に書くと、
 * **クランプが効いていないのと同じ**になる。
 *
 * (実例: テロップの左端を右へ引くと、最小尺 0.2 秒に収めたはずの位置から
 *  自分自身の終端へスナップして**尺が 0 秒**になった。尺 0 のテロップは
 *  プレビューの判定 `startTime <= t < endTime` を絶対に満たさず、書き出しでも
 *  ASS の Start と End が同じになるので、**画面からも出力からも消える**。
 *  実測: 2.0〜4.0 のテロップで、3.9 秒に候補があるズーム100%では尺 0.1 秒、
 *  4.3 秒に候補があるズーム36%では尺 0.0 秒。本編クリップのトリムと
 *  音声/PiPのトリムはスナップのあとにもう一度挟んでおり、テロップだけ抜けていた)
 *
 * 挟み直して位置が動いたときは `snapped` を false で返す——実際にはくっついて
 * いないのに、案内線だけ出てしまうのを防ぐため。
 */
export function snapClamped(
  rawTime: number,
  candidates: number[],
  thresholdSeconds: number,
  min: number,
  max: number
): SnapResult {
  const snap = snapTime(rawTime, candidates, thresholdSeconds)
  const clamped = Math.min(max, Math.max(min, snap.time))
  return { time: clamped, snapped: snap.snapped && clamped === snap.time }
}

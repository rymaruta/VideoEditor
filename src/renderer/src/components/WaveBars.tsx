import type { WaveLevels } from '../lib/timelineWave'

/** 振れ幅の上限(高さに対して)。タイムラインの波形と同じく、上下に余白を残す */
const AMP_SHARE = 0.8

/** 縦の棒を 2px おきに並べた形(値は平方根で持ち上げて小さな声も見せる) */
function barsPath(levels: ArrayLike<number>, width: number, height: number): string {
  const mid = height / 2
  const max = mid * AMP_SHARE
  const n = levels.length
  let d = ''
  for (let x = 0; x < width; x += 2) {
    const v = n > 0 ? levels[Math.min(n - 1, Math.floor((x / width) * n))] : 0
    const h = Math.max(0.5, Math.sqrt(Math.max(0, Math.min(1, v || 0))) * max)
    d += `M${x} ${(mid - h).toFixed(1)}h1.2V${(mid + h).toFixed(1)}h-1.2z`
  }
  return d
}

/**
 * 小さな波形。確認の画面・書き出しの画面で使う。
 * 色は波形の 1 色で、外側の山は淡く(--ve-wave-outer)、内側の平均は濃く(--ve-wave-inner)。
 * 振れ幅は高さの 80% まで(タイムラインの波形と同じ決まり)
 */
export function WaveBars({
  levels,
  width,
  height,
  className
}: {
  levels: WaveLevels
  /** 描く座標の幅(viewBox。表示の大きさは CSS で決める) */
  width: number
  height: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={`ve-wave-bars ${className ?? ''}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="ve-wave-peak" d={barsPath(levels.peak, width, height)} />
      <path className="ve-wave-rms" d={barsPath(levels.rms, width, height)} />
    </svg>
  )
}

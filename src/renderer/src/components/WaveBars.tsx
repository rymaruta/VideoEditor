/**
 * 小さな波形(縦の棒を 2px おきに並べる)。確認の画面・書き出しの画面で使う。
 * 色は波形の 1 色(--ve-wave。持ち主の必須要件)。値は 0〜1 で、平方根で持ち上げて小さな声も見せる
 */
export function WaveBars({
  levels,
  width,
  height,
  className
}: {
  levels: ArrayLike<number>
  /** 描く座標の幅(viewBox。表示の大きさは CSS で決める) */
  width: number
  height: number
  className?: string
}): React.JSX.Element {
  const mid = height / 2
  const n = levels.length
  let d = ''
  for (let x = 0; x < width; x += 2) {
    const v = n > 0 ? levels[Math.min(n - 1, Math.floor((x / width) * n))] : 0
    const h = Math.max(0.5, Math.sqrt(Math.max(0, Math.min(1, v || 0))) * (mid - 0.5))
    d += `M${x} ${(mid - h).toFixed(1)}h1.2V${(mid + h).toFixed(1)}h-1.2z`
  }
  return (
    <svg
      className={`ve-wave-bars ${className ?? ''}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

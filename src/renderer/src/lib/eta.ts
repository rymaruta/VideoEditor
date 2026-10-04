/**
 * 残り時間の目安(ミリ秒)。ここまでの進み方がこのまま続くとして見積もる。
 * 始まった直後・進み具合が小さいうちは当てにならないので出さない(null)。
 */
export function remainingMs(
  startedAt: number | undefined,
  percent: number,
  now: number
): number | null {
  if (startedAt === undefined || !Number.isFinite(percent)) return null
  const elapsed = now - startedAt
  if (elapsed < 5000 || percent < 10 || percent >= 100) return null
  return (elapsed * (100 - percent)) / percent
}

/** 「残り約3分」などの表示(1分未満は「まもなく」) */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return 'まもなく'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `残り約${min}分`
  const h = Math.floor(min / 60)
  const m = min % 60
  return `残り約${h}時間${m > 0 ? `${m}分` : ''}`
}

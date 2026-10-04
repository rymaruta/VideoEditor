/**
 * 長い処理(自動編集・書き出し)の最中であることを main へ知らせる(理由は main の busyState)。
 * 処理ごとに鍵を分けて持ち、どれか1つでも動いていれば「処理中」。進み具合の知らせは間引く。
 */
export interface BusyReport {
  label: string
  percent?: number
}

const states = new Map<string, BusyReport>()
let timer: ReturnType<typeof setTimeout> | null = null
let lastSent: string | null = null

function send(): void {
  timer = null
  const first = states.values().next().value as BusyReport | undefined
  const payload = first ? { label: first.label, percent: first.percent } : null
  const key = JSON.stringify(payload)
  if (key === lastSent) return
  lastSent = key
  window.api.setBusyState(payload)
}

export function reportBusy(key: string, state: BusyReport | null): void {
  const wasBusy = states.size > 0
  if (state) states.set(key, state)
  else states.delete(key)
  // 始まり・終わりはすぐに、進み具合は 0.5 秒ごとに
  if (wasBusy !== states.size > 0) {
    if (timer) clearTimeout(timer)
    send()
  } else if (!timer) timer = setTimeout(send, 500)
}

/** 自動編集の全体の進み具合(終わった工程の数 + 動いている工程の進み具合) */
export function overallPercent(steps: readonly { state: string; percent: number }[]): number {
  if (steps.length === 0) return 0
  let done = 0
  for (const s of steps) {
    if (s.state === 'done' || s.state === 'skipped' || s.state === 'error') done += 1
    else if (s.state === 'run') done += Math.max(0, Math.min(100, s.percent)) / 100
  }
  return (done / steps.length) * 100
}

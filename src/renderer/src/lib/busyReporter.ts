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

/** 自動編集が reportBusy に使う鍵。これが外れたら1回の通しが終わった(全体の進み具合の床を戻す) */
export const PIPELINE_BUSY_KEY = 'pipeline'

export function reportBusy(key: string, state: BusyReport | null): void {
  const wasBusy = states.size > 0
  if (state) states.set(key, state)
  else states.delete(key)
  if (!state && key === PIPELINE_BUSY_KEY) resetOverallPercent()
  // 始まり・終わりはすぐに、進み具合は 0.5 秒ごとに
  if (wasBusy !== states.size > 0) {
    if (timer) clearTimeout(timer)
    send()
  } else if (!timer) timer = setTimeout(send, 500)
}

/** この回で出した全体の進み具合のいちばん大きい値。null = 回の外 */
let overallFloor: number | null = null

/** 新しい回を始める(全体の進み具合の床を外す) */
export function resetOverallPercent(): void {
  overallFloor = null
}

/**
 * 自動編集の全体の進み具合(終わった工程の数 + 動いている工程の進み具合)。
 *
 * 工程の中で段階が変わると、その工程の進み具合が 0 に戻る(読み込み 100% → 解析 0%)。
 * そのまま出すとタスクバーの進み具合が後ろへ跳ぶので、**1回の通しの中では下げない**。
 * 床は通しが終わったとき(reportBusy の鍵が外れたとき)と、どの工程も手付かずのときに外す。
 */
export function overallPercent(steps: readonly { state: string; percent: number }[]): number {
  const raw = rawOverallPercent(steps)
  if (steps.every((s) => s.state === 'wait')) overallFloor = null
  const value = overallFloor === null ? raw : Math.max(overallFloor, raw)
  overallFloor = value
  return value
}

function rawOverallPercent(steps: readonly { state: string; percent: number }[]): number {
  if (steps.length === 0) return 0
  let done = 0
  for (const s of steps) {
    if (s.state === 'done' || s.state === 'skipped' || s.state === 'error') done += 1
    else if (s.state === 'run') {
      const p = Number.isFinite(s.percent) ? s.percent : 0
      done += Math.max(0, Math.min(100, p)) / 100
    }
  }
  return (done / steps.length) * 100
}

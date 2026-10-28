import { getTotalDuration, useProjectStore } from '../store/projectStore'
import { stepFrames } from './editCommands'

/**
 * J / K / L のシャトル(Premiere・DaVinci と同じ押し方)。
 *
 * - L: 再生。止まっていれば等倍、押すたび 2倍 → 4倍
 * - J: 戻る方向。押すたび 1倍 → 2倍 → 4倍
 * - K: 止める。K を押したまま J / L で1フレームずつ戻る・進む
 *
 * **等倍の前向きはふつうの再生**(音も出る)。プレビューは `<video>` の再生に乗っていて、
 * `playbackRate` は負の値を受け付けない(Chromium は代入した時点で投げる)。そのため
 * **戻る方向と 2倍・4倍は「再生位置を一定の間隔で送る」**(画は出るが音は出ない)。
 * 送っている途中にスペースなどでふつうの再生が始まったら、送るのをやめる。
 */

/** 送る間隔(ミリ秒)。タイムラインのつまみを引きずったときと同じくらいの頻度 */
export const SHUTTLE_TICK_MS = 66
export const MAX_SHUTTLE_RATE = 4

/** J / K / L を押したあとの速さ(負は戻る方向、0 は停止) */
export function nextShuttleRate(current: number, key: 'j' | 'k' | 'l'): number {
  if (key === 'k') return 0
  const direction = key === 'l' ? 1 : -1
  if (Math.sign(current) === direction) {
    return direction * Math.min(MAX_SHUTTLE_RATE, Math.abs(current) * 2)
  }
  return direction
}

interface ShuttleOptions {
  /** 今の時刻(ミリ秒)。試験では差し替える */
  now?: () => number
  /** true の間は送るのをやめる(ダイアログが開いた など) */
  shouldStop?: () => boolean
}

let rate = 0
let timer: ReturnType<typeof setInterval> | null = null
let lastAt = 0
let session = -1
let options: ShuttleOptions = {}
let kHeld = false

const clock = (): number => (options.now ?? Date.now)()

/** 今の速さ(送っていなければ、ふつうの再生中は 1、止まっていれば 0) */
export function currentShuttleRate(): number {
  if (timer !== null) return rate
  return useProjectStore.getState().isPlaying ? 1 : 0
}

/** 再生位置を送っている最中か(ふつうの再生は含まない) */
export function isShuttling(): boolean {
  return timer !== null
}

export function stopShuttle(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  rate = 0
}

function tick(): void {
  const s = useProjectStore.getState()
  // ふつうの再生が始まった・企画が替わった・ダイアログが開いた → 送るのをやめる
  if (s.isPlaying || s.projectSession !== session || options.shouldStop?.()) {
    stopShuttle()
    return
  }
  const now = clock()
  const dt = Math.max(0, (now - lastAt) / 1000)
  lastAt = now
  const total = getTotalDuration(s.project)
  const next = Math.max(0, Math.min(total, s.playheadTime + rate * dt))
  if (next !== s.playheadTime) s.seekTo(next)
  if (next <= 0 || next >= total) stopShuttle()
}

/** 速さを決めて動かす(0 で止める、1 でふつうの再生、それ以外は再生位置を送る) */
export function setShuttleRate(next: number, opts: ShuttleOptions = {}): void {
  stopShuttle()
  const s = useProjectStore.getState()
  if (next === 0) {
    if (s.isPlaying) s.setIsPlaying(false)
    return
  }
  if (next === 1) {
    if (!s.isPlaying) s.togglePlayback()
    return
  }
  if (s.isPlaying) s.setIsPlaying(false)
  const total = getTotalDuration(s.project)
  // 端に居て、その向きへは送れない
  if ((next < 0 && s.playheadTime <= 0) || (next > 0 && s.playheadTime >= total)) return
  options = opts
  rate = next
  session = s.projectSession
  lastAt = clock()
  timer = setInterval(tick, SHUTTLE_TICK_MS)
}

/** J / K / L が押された。K を押したままの J / L は1フレーム送り */
export function pressShuttleKey(key: 'j' | 'k' | 'l', opts: ShuttleOptions = {}): void {
  if (key !== 'k' && kHeld) {
    stopShuttle()
    const s = useProjectStore.getState()
    if (s.isPlaying) s.setIsPlaying(false)
    stepFrames(key === 'l' ? 1 : -1)
    return
  }
  if (key === 'k') kHeld = true
  setShuttleRate(nextShuttleRate(currentShuttleRate(), key), opts)
}

/** K を押したままか */
export function isShuttleKHeld(): boolean {
  return kHeld
}

/** K を離した(窓からフォーカスが外れたときも呼ぶ。離したのが届かず押したままになるので) */
export function releaseShuttleK(): void {
  kHeld = false
}

let rangeWatch: (() => void) | null = null

/** イン〜アウトの再生(Ctrl+Shift+Space)の最中か */
export function isRangePlaying(): boolean {
  return rangeWatch !== null
}

/** イン〜アウトの再生を見張るのをやめる */
export function stopRangePlayback(): void {
  rangeWatch?.()
  rangeWatch = null
}

/**
 * イン〜アウトを再生する(Ctrl+Shift+Space)。アウトに着いたら止める。
 * ループ再生がオンなら止めずにインへ戻って繰り返す(`loopPlayback`)。
 * 途中で止めた・企画が替わったら見張りをやめる。始めたら true
 */
export function playRange(from: number, to: number): boolean {
  stopShuttle()
  stopRangePlayback()
  const s = useProjectStore.getState()
  const total = getTotalDuration(s.project)
  const end = Math.min(to, total)
  if (!(end - from > 1e-3) || from < 0) return false
  const startSession = s.projectSession
  s.seekTo(from)
  s.setIsPlaying(true)
  let ownSeek = useProjectStore.getState().seekRequest
  let selfSeeking = false
  const unsubscribe = useProjectStore.subscribe((state, prev) => {
    if (!state.isPlaying || state.projectSession !== startSession) {
      stopRangePlayback()
      return
    }
    // 手で再生位置を動かしたら、イン〜アウトの見張りはやめる(ふつうの再生として続ける。引き戻さない)
    if (!selfSeeking && state.seekRequest !== prev.seekRequest && state.seekRequest !== ownSeek) {
      stopRangePlayback()
      return
    }
    if (state.playheadTime >= end - 1e-3) {
      if (state.loopPlayback) {
        selfSeeking = true
        state.seekTo(from)
        selfSeeking = false
        ownSeek = useProjectStore.getState().seekRequest
        return
      }
      stopRangePlayback()
      state.setIsPlaying(false)
      state.seekTo(end)
    }
  })
  rangeWatch = unsubscribe
  return true
}

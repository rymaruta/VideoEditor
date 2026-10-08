/**
 * main プロセスが起こした外部の処理(ffmpeg)の一覧。アプリを閉じるときに止める。
 *
 * macOS・Linux では子プロセスは親が終わっても動き続ける。数時間のノイズ除去や試聴用素材の変換の途中で
 * 閉じると、ffmpeg が CPU を使い続け、途中のファイル(.part など)が残る。
 */
interface Killable {
  kill(signal: 'SIGKILL'): unknown
}

const live = new Set<Killable>()
let shuttingDown = false

/** アプリを閉じている最中か(止めた処理を「失敗したので作り直す」に回さないため) */
export function isShuttingDown(): boolean {
  return shuttingDown
}

/** 登録し、終わったら外す関数を返す。閉じている最中に始まったものは、すぐ止める */
export function trackProcess(p: Killable): () => void {
  if (shuttingDown) {
    try {
      p.kill('SIGKILL')
    } catch {
      // すでに終わっている
    }
    return () => {}
  }
  live.add(p)
  return () => {
    live.delete(p)
  }
}

export function killLiveProcesses(): void {
  shuttingDown = true
  for (const p of live) {
    try {
      p.kill('SIGKILL')
    } catch {
      // すでに終わっている
    }
  }
  live.clear()
}

interface Watchable extends Killable {
  once(event: string, listener: (...args: unknown[]) => void): unknown
}

/**
 * 登録し、終わったら(`events` のどれかが来たら)自動で外す。始めたその場で包む:
 * `trackUntilDone(spawn(...))`・`trackUntilDone(ffmpeg(path), ['end', 'error'])`。
 * 包んでいない ffmpeg(サムネイル・無音の検出・文字起こしの音声の取り出し など)は、
 * アプリを閉じても動き続けていた(3時間の素材の無音検出が、閉じた後も CPU を使い続けた)
 */
export function trackUntilDone<T extends Watchable>(p: T, events = ['close', 'error']): T {
  const untrack = trackProcess(p)
  for (const e of events) p.once(e, untrack)
  // fluent-ffmpeg は `.run()` の後に遅れて ffmpeg を起こし、起こす前の kill は何もしない。
  // 起きた時点で閉じている最中なら、そこで止める(閉じた後に3時間ぶんの無音検出が走り続けていた)
  p.once('start', () => {
    if (!shuttingDown) return
    try {
      p.kill('SIGKILL')
    } catch {
      // すでに終わっている
    }
  })
  return p
}

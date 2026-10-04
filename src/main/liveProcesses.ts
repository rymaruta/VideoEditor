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

/** 登録し、終わったら外す関数を返す */
export function trackProcess(p: Killable): () => void {
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

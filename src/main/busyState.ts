import { BrowserWindow, Notification, powerSaveBlocker } from 'electron'

/**
 * 長い処理(自動編集・書き出し)の最中であること。
 *
 * - その間は PC をスリープさせない(実際の回は数時間かかる。夜に流して寝ている間に止まらないように)
 * - Windows のタスクバーのボタンに進み具合を出す(ほかの画面を見ていても分かる)
 * - 閉じようとしたら確かめる(途中の処理が失われる)
 */
export interface BusyState {
  /** 何をしているか(「自動編集: 文字起こし」など) */
  label: string
  /** 0〜100。分からなければ undefined */
  percent?: number
}

let busy: BusyState | null = null
let blockerId: number | null = null

export function currentBusy(): BusyState | null {
  return busy
}

export function setBusy(win: BrowserWindow | null, state: BusyState | null): void {
  busy = state
  if (state && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension')
  if (!state && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
  if (!win || win.isDestroyed()) return
  if (!state) win.setProgressBar(-1)
  else if (state.percent === undefined || !Number.isFinite(state.percent))
    win.setProgressBar(2) // 1 より大きい値は「進み具合が分からない」表示
  else win.setProgressBar(Math.max(0, Math.min(1, state.percent / 100)))
}

/** 終わったことを知らせる。アプリを見ていないときだけ(見ていれば画面で分かる) */
export function notifyDone(win: BrowserWindow | null, title: string, body: string): void {
  if (!win || win.isDestroyed() || win.isFocused()) return
  if (Notification.isSupported()) {
    const n = new Notification({ title, body })
    n.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.focus()
    })
    n.show()
  }
  // タスクバーのボタンも点滅させる(通知を切っていても気付けるように)
  win.flashFrame(true)
}

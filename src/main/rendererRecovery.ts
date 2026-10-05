/**
 * 画面のプロセスが落ちたとき(メモリ不足・GPU の不調など)に、自動で読み込み直してよいかの判断。
 *
 * 落ちた画面は**真っ白のまま**残り、利用者はアプリを閉じるしかなかった
 * (実測: 60分・テロップ1000枚の書き出しで画面のプロセスが消えたあと、窓は白いまま何も出なかった)。
 * 読み込み直せば起動時と同じ流れで自動保存(60秒ごと)から戻せる。
 *
 * ただし、開いた直後に毎回落ちる原因(壊れた自動保存など)だと、読み込み直すたびに落ちて
 * 止まらなくなる。短い間に何度も落ちたら自動ではやり直さず、利用者に知らせる。
 */
export class RendererCrashGuard {
  private readonly crashes: number[] = []

  constructor(
    /** この回数まで自動で読み込み直す */
    private readonly maxReloads = 2,
    /** 数える期間(ms) */
    private readonly windowMs = 5 * 60 * 1000
  ) {}

  /** 落ちたことを記録し、自動で読み込み直してよいかを返す */
  shouldReload(reason: string, now = Date.now()): boolean {
    // 自分で閉じた・正常に終わったときは何もしない
    if (reason === 'clean-exit') return false
    while (this.crashes.length > 0 && now - this.crashes[0] > this.windowMs) this.crashes.shift()
    this.crashes.push(now)
    return this.crashes.length <= this.maxReloads
  }
}

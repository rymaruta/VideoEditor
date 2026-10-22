/**
 * 画面の未処理のエラーを main の記録(userData/logs)へ送る。記録の決まりは main の crashLog.ts。
 * 送るのはエラーの種類・メッセージ・スタックだけ(企画の中身は送らない)。どこにも自動では送信しない。
 */

/** 害がなく、毎回出て記録を埋めるだけのもの */
const IGNORED = [/^ResizeObserver loop/i]

function describe(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error)
    return { message: `${reason.name}: ${reason.message}`, stack: reason.stack }
  if (typeof reason === 'string') return { message: reason }
  try {
    return { message: JSON.stringify(reason) ?? String(reason) }
  } catch {
    return { message: String(reason) }
  }
}

/** 1件送る(preload が無い環境・送れないときは何もしない) */
export function reportRendererError(kind: string, reason: unknown, extraStack?: string): void {
  try {
    const { message, stack } = describe(reason)
    if (IGNORED.some((r) => r.test(message))) return
    const api = (globalThis as { window?: { api?: { logRendererError?: unknown } } }).window?.api
    if (typeof api?.logRendererError !== 'function') return
    window.api.logRendererError({
      kind,
      message: message.slice(0, 4000),
      stack: [stack, extraStack].filter(Boolean).join('\n').slice(0, 8000) || undefined
    })
  } catch {
    // 記録できなくても画面は続ける
  }
}

let installed = false

/** 画面の起動時に1回 */
export function installRendererErrorLogging(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (e) => {
    reportRendererError('画面の未処理の例外', e.error ?? e.message)
  })
  window.addEventListener('unhandledrejection', (e) => {
    reportRendererError('画面の未処理の拒否', e.reason)
  })
}

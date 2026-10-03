import { utilityProcess, type UtilityProcess } from 'electron'

/**
 * utilityProcess で処理を動かし、メッセージを受け取る(childMain の相手側)。
 * `onMessage` が true を返したら終わり(プロセスを閉じる)。
 */
export function runChild(
  modulePath: string,
  input: unknown,
  onMessage: (m: { type: string } & Record<string, unknown>) => boolean | void,
  onExit: (code: number, stderrTail: string) => void
): UtilityProcess {
  const child = utilityProcess.fork(modulePath, [], {
    stdio: ['ignore', 'ignore', 'pipe'],
    serviceName: 'VideoEditor 解析'
  })
  // 異常終了したときに理由を示せるよう、標準エラーの末尾だけ持っておく
  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-4000)
  })
  let finished = false
  child.on('message', (m: { type: string } & Record<string, unknown>) => {
    if (finished) return
    if (onMessage(m) === true) {
      finished = true
      child.kill()
    }
  })
  child.on('exit', (code) => {
    if (!finished) {
      finished = true
      onExit(code, stderr.trim().split('\n').slice(-3).join(' / '))
    }
  })
  child.postMessage(input)
  return child
}

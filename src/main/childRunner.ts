import { utilityProcess, type UtilityProcess } from 'electron'

/**
 * utilityProcess で処理を動かし、メッセージを受け取る(childMain の相手側)。
 * `onMessage` が true を返したら終わり(プロセスを閉じる)。
 */
export function runChild(
  modulePath: string,
  input: unknown,
  onMessage: (m: { type: string } & Record<string, unknown>) => boolean | void,
  onExit: (code: number) => void
): UtilityProcess {
  const child = utilityProcess.fork(modulePath, [], {
    stdio: 'ignore',
    serviceName: 'VideoEditor 解析'
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
      onExit(code)
    }
  })
  child.postMessage(input)
  return child
}

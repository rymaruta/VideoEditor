import { app, type UtilityProcess } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import asrWorkerPath from './asrWorker?modulePath'
import { ffmpegPath } from './ffmpegService'
import { runChild } from './childRunner'
import type { AsrJob, AsrJobResult, AsrWorkerMessage } from '@shared/transcript'

/**
 * 音声認識の呼び出し口。計算は `asrWorker`(別プロセス。理由は childMain)で行い、ここは結果を集めて返す。
 * モデルは userData/models に置く(既存の自動テロップと同じ置き場。入れ直しても残る)。
 */

let running: UtilityProcess | null = null
let canceled = false

export function runAsr(
  jobs: AsrJob[],
  onMessage: (m: Exclude<AsrWorkerMessage, { type: 'result' | 'done' | 'error' }>) => void
): Promise<AsrJobResult[]> {
  if (running) return Promise.reject(new Error('音声認識はすでに実行中です'))
  const cacheDir = join(app.getPath('userData'), 'models')
  mkdirSync(cacheDir, { recursive: true })
  canceled = false
  return new Promise((resolve, reject) => {
    const results: AsrJobResult[] = []
    running = runChild(
      asrWorkerPath,
      { jobs, ffmpegPath, cacheDir },
      (raw) => {
        const m = raw as unknown as AsrWorkerMessage
        if (m.type === 'result') results.push(m.result)
        else if (m.type === 'done') {
          running = null
          resolve(results)
          return true
        } else if (m.type === 'error') {
          running = null
          reject(new Error(m.message))
          return true
        } else onMessage(m)
        return false
      },
      (code, stderr) => {
        running = null
        // 中止は自分で止めたときだけ(DirectML などが標準エラーに警告を出していても中止と分かるように。
        // 逆に、標準エラーが空のまま落ちたのを「中止」と見せない)
        reject(
          new Error(
            canceled
              ? 'ASR_CANCELED'
              : `音声認識が止まりました(終了コード ${code})${stderr ? `: ${stderr}` : ''}`
          )
        )
      }
    )
  })
}

export function cancelAsr(): void {
  canceled = true
  running?.kill()
}

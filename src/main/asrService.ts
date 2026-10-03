import { app } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import asrWorkerPath from './asrWorker?modulePath'
import { ffmpegPath } from './ffmpegService'
import type { AsrJob, AsrJobResult, AsrWorkerMessage } from '@shared/transcript'

/**
 * 音声認識の呼び出し口。計算は `asrWorker`(別スレッド)で行い、ここは結果を集めて返す。
 * モデルは userData/models に置く(既存の自動テロップと同じ置き場。入れ直しても残る)。
 */

let running: Worker | null = null

export function runAsr(
  jobs: AsrJob[],
  onMessage: (m: Exclude<AsrWorkerMessage, { type: 'result' | 'done' | 'error' }>) => void
): Promise<AsrJobResult[]> {
  if (running) return Promise.reject(new Error('音声認識はすでに実行中です'))
  const cacheDir = join(app.getPath('userData'), 'models')
  mkdirSync(cacheDir, { recursive: true })
  return new Promise((resolve, reject) => {
    const worker = new Worker(asrWorkerPath, { workerData: { jobs, ffmpegPath, cacheDir } })
    running = worker
    const results: AsrJobResult[] = []
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      running = null
      fn()
    }
    worker.on('message', (m: AsrWorkerMessage) => {
      if (m.type === 'result') results.push(m.result)
      else if (m.type === 'done') {
        finish(() => resolve(results))
        void worker.terminate()
      } else if (m.type === 'error') finish(() => reject(new Error(m.message)))
      else onMessage(m)
    })
    worker.on('error', (e) => finish(() => reject(e)))
    worker.on('exit', (code) =>
      finish(() =>
        reject(new Error(code === 1 ? 'ASR_CANCELED' : `音声認識が止まりました(${code})`))
      )
    )
  })
}

export function cancelAsr(): void {
  void running?.terminate()
}

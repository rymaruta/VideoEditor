import { app, type UtilityProcess } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import llmWorkerPath from './llmWorker?modulePath'
import { runChild } from './childRunner'
import type { LlmRequest, LlmWorkerMessage } from '@shared/llm'

/** このPCの言語モデルの呼び出し口(計算は llmWorker、別プロセス)。答えられなかった頼みは null */
let running: UtilityProcess | null = null

export function runLlm(
  requests: LlmRequest[],
  onMessage: (m: Exclude<LlmWorkerMessage, { type: 'done' | 'error' }>) => void
): Promise<(unknown | null)[]> {
  if (running) return Promise.reject(new Error('AI はすでに実行中です'))
  const cacheDir = join(app.getPath('userData'), 'models')
  mkdirSync(cacheDir, { recursive: true })
  return new Promise((resolve, reject) => {
    running = runChild(
      llmWorkerPath,
      { requests, cacheDir, modelUri: process.env.VE_LOCAL_LLM_MODEL || undefined },
      (raw) => {
        const m = raw as unknown as LlmWorkerMessage
        if (m.type === 'done') {
          running = null
          resolve(m.results)
          return true
        }
        if (m.type === 'error') {
          running = null
          reject(new Error(m.message))
          return true
        }
        onMessage(m)
        return false
      },
      (code, stderr) => {
        running = null
        reject(new Error(code === 0 || !stderr ? 'LLM_CANCELED' : `AI が止まりました: ${stderr}`))
      }
    )
  })
}

export function cancelLlm(): void {
  running?.kill()
}

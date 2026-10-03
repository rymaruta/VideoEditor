import { app, type UtilityProcess } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import llmWorkerPath from './llmWorker?modulePath'
import { runChild } from './childRunner'
import type { LlmRequest, LlmWorkerMessage } from '@shared/llm'

/** このPCの言語モデルの呼び出し口(計算は llmWorker、別プロセス)。答えられなかった頼みは null */
let running: UtilityProcess | null = null
let canceling: (() => void) | null = null

/**
 * 別プロセスが答えずに終わったときの理由。
 * CPU で動かすときは、モデルの重みを1度に確保するため(7B で約4GB)、Electron のメモリ確保の上限に
 * 当たって落ちることがある(Linux で確認。GPU ならモデルは GPU のメモリに載るので当たらない)。
 */
function crashReason(code: number, stderr: string, device: string | undefined): string {
  if (device === 'cpu')
    return `このPCの AI を CPU で動かせませんでした(終了コード ${code})。GPU(NVIDIA など)で動かすか、AI に Gemini を選んでください`
  return `AI が途中で止まりました(終了コード ${code})${stderr ? `: ${stderr}` : ''}`
}

export function runLlm(
  requests: LlmRequest[],
  onMessage: (m: Exclude<LlmWorkerMessage, { type: 'done' | 'error' }>) => void
): Promise<(unknown | null)[]> {
  if (running) return Promise.reject(new Error('AI はすでに実行中です'))
  const cacheDir = join(app.getPath('userData'), 'models')
  mkdirSync(cacheDir, { recursive: true })
  return new Promise((resolve, reject) => {
    let device: string | undefined
    let canceled = false
    canceling = () => (canceled = true)
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
        if (m.type === 'device') device = m.device
        onMessage(m)
        return false
      },
      (code, stderr) => {
        running = null
        canceling = null
        if (canceled) return reject(new Error('LLM_CANCELED'))
        reject(new Error(crashReason(code, stderr, device)))
      }
    )
  })
}

export function cancelLlm(): void {
  canceling?.()
  running?.kill()
}

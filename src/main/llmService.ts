import { app, type UtilityProcess } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import llmWorkerPath from './llmWorker?modulePath'
import { runChild } from './childRunner'
import { LlmLoadFailures, LlmLoadTracker } from './llmLoadFailures'
import {
  loadCrashedMessage,
  type LlmLoadFailure,
  type LlmRequest,
  type LlmWorkerMessage
} from '@shared/llm'

/** このPCの言語モデルの呼び出し口(計算は llmWorker、別プロセス)。答えられなかった頼みは null */
let running: UtilityProcess | null = null
let canceling: (() => void) | null = null
let failures: LlmLoadFailures | null = null

function loadFailures(): LlmLoadFailures {
  failures ??= new LlmLoadFailures(join(app.getPath('userData'), 'llm-load-failures.json'))
  return failures
}

/** 読み込めなかったモデルの一覧(自動編集の画面の「もう一度試す」に使う) */
export function listLlmLoadFailures(): LlmLoadFailure[] {
  return loadFailures().list()
}

/** 「このPCの AI をもう一度試す」: 読み込めなかった記録を消す */
export function clearLlmLoadFailures(): void {
  loadFailures().clear()
}

/**
 * 別プロセスが答えずに終わったときの理由。
 * 読み込みの途中(どのモデルかを知らせた後、最初の答えの前)で落ちたら、そのモデルは このPCでは
 * 読み込めないと覚えて、次からは試さない。CPU で動かすと、モデルの重みを1度に確保するところで
 * Electron のメモリ確保の上限に当たって落ちることがある(Linux で確認)。
 */
export function crashMessage(
  code: number,
  stderr: string,
  loading: { label: string } | null
): string {
  if (loading) return loadCrashedMessage(loading.label)
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
    /** 読み込み中のモデル(読み込み終わりで null) */
    const tracker = new LlmLoadTracker()
    let canceled = false
    canceling = () => (canceled = true)
    running = runChild(
      llmWorkerPath,
      {
        requests,
        cacheDir,
        modelUri: process.env.VE_LOCAL_LLM_MODEL || undefined,
        skipModels: loadFailures()
          .list()
          .map((f) => f.uri)
      },
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
        tracker.observe(m)
        onMessage(m)
        return false
      },
      (code, stderr) => {
        running = null
        canceling = null
        if (canceled) return reject(new Error('LLM_CANCELED'))
        const loading = tracker.loading()
        if (loading?.uri) loadFailures().add(loading.uri, loading.label)
        reject(new Error(crashMessage(code, stderr, loading)))
      }
    )
  })
}

export function cancelLlm(): void {
  canceling?.()
  running?.kill()
}

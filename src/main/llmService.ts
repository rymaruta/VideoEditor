import { app, type UtilityProcess } from 'electron'
import { mkdirSync } from 'fs'
import { totalmem } from 'os'
import { join } from 'path'
import llmWorkerPath from './llmWorker?modulePath'
import { runChild } from './childRunner'
import { classifyLlmExit, LlmLoadFailures, LlmLoadTracker } from './llmLoadFailures'
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
/** アプリの終了中(終了で閉じられた解析のプロセスを「読み込めなかった」と覚えない) */
let quitting = false
app.on('before-quit', () => {
  quitting = true
})

const ramGb = (): number => totalmem() / 1024 ** 3

function loadFailures(): LlmLoadFailures {
  failures ??= new LlmLoadFailures(join(app.getPath('userData'), 'llm-load-failures.json'))
  return failures
}

/** 今の環境で効く、読み込めなかったモデルの一覧(自動編集の画面の「もう一度試す」に使う) */
export function listLlmLoadFailures(): LlmLoadFailure[] {
  return loadFailures().current(app.getVersion(), ramGb())
}

/** 「このPCの AI をもう一度試す」: 読み込めなかった記録を消す */
export function clearLlmLoadFailures(): void {
  loadFailures().clear()
}

/**
 * 別プロセスが答えずに終わったときの理由。
 * 読み込みの途中(どのモデルかを知らせた後、読み込み終わりの前)で落ちたら、そのモデルは このPCでは
 * 読み込めないと覚えて、次からは試さない。
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
        appVersion: app.getVersion(),
        skipModels: listLlmLoadFailures()
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
        const kind = classifyLlmExit({ canceled, quitting, code })
        if (kind === 'canceled') return reject(new Error('LLM_CANCELED'))
        if (kind === 'quitting') return reject(new Error('アプリを終了しています'))
        const loading = tracker.loading()
        if (kind === 'clean')
          return reject(new Error('AI が答えを返さずに終わりました(次はもう一度試します)'))
        if (loading?.uri)
          loadFailures().add(loading.uri, loading.label, {
            appVersion: app.getVersion(),
            gpu: loading.gpu,
            vramGb: loading.vramGb,
            ramGb: ramGb()
          })
        reject(new Error(crashMessage(code, stderr, loading)))
      }
    )
  })
}

export function cancelLlm(): void {
  canceling?.()
  running?.kill()
}

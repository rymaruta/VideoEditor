import { childMain } from './childMain'
import { totalmem } from 'os'
import { judgeLocalAi, type LocalAiCheck } from '@shared/envCheck'
import type { LlmLoadFailure } from '@shared/llm'

/**
 * 環境チェックのうち、ネイティブの部品を読み込む所(node-llama-cpp の GPU の判定と、onnxruntime が
 * 使える装置)を別プロセスで調べる(落ちても本体は落ちない。理由は childMain)。
 * **モデルはダウンロードも読み込みもしない。** node-llama-cpp は同梱の部品だけで判定する(build: never。
 * その場でのビルドはしない)。
 */

interface WorkerInput {
  appVersion: string
  failures: LlmLoadFailure[]
}

export interface EnvCheckWorkerDone {
  type: 'done'
  localAi: LocalAiCheck
  backends: string[]
  backendsError?: string
}

const GB = 1024 ** 3

childMain<WorkerInput>(async (input, post) => {
  let localAi: LocalAiCheck
  try {
    const { getLlama } = await import('node-llama-cpp')
    const llama = await getLlama({ gpu: 'auto', build: 'never' })
    const vramState = llama.gpu ? await llama.getVramState() : null
    const gpuNames = llama.gpu ? await llama.getGpuDeviceNames().catch(() => []) : []
    localAi = judgeLocalAi({
      gpu: llama.gpu,
      vramGb: vramState ? vramState.total / GB : 0,
      unifiedMemory: (vramState?.unifiedSize ?? 0) > 0,
      gpuNames,
      ramGb: totalmem() / GB,
      appVersion: input.appVersion,
      failures: input.failures ?? []
    })
    await llama.dispose().catch(() => undefined)
  } catch (e) {
    localAi = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  let backends: string[] = []
  let backendsError: string | undefined
  try {
    const ort = (await import('onnxruntime-node')) as unknown as {
      listSupportedBackends?: () => { name: string }[]
    }
    backends = (ort.listSupportedBackends?.() ?? []).map((b) => b.name)
  } catch (e) {
    backendsError = e instanceof Error ? e.message : String(e)
  }
  const done: EnvCheckWorkerDone = { type: 'done', localAi, backends, backendsError }
  post(done)
})

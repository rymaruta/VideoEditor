import { childMain } from './childMain'
import { existsSync } from 'fs'
import { totalmem } from 'os'
import { dirname, join } from 'path'
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
    backends = (ort.listSupportedBackends?.() ?? [])
      .map((b) => b.name)
      .filter((name) => providerShipped(name))
  } catch (e) {
    backendsError = e instanceof Error ? e.message : String(e)
  }
  const done: EnvCheckWorkerDone = { type: 'done', localAi, backends, backendsError }
  post(done)
})

/**
 * Linux の配布物は CUDA・TensorRT の部品(libonnxruntime_providers_*.so)を外している
 * (electron-builder.cjs)。listSupportedBackends はビルド時の一覧を返すだけなので、部品が
 * 無いものは「使える」に並べない。部品の場所が分からないときは一覧のまま残す。
 */
function providerShipped(name: string): boolean {
  if (process.platform !== 'linux' || (name !== 'cuda' && name !== 'tensorrt')) return true
  try {
    const binding = require.resolve(
      `onnxruntime-node/bin/napi-v6/linux/${process.arch}/onnxruntime_binding.node`
    )
    const dir = dirname(binding).replace('app.asar' + '/', 'app.asar.unpacked/')
    return existsSync(join(dir, `libonnxruntime_providers_${name}.so`))
  } catch {
    return true
  }
}

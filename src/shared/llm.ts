/**
 * 構成の判定・演出テロップの提案に使う言語モデル(AI)の共通の形。
 *
 * - `local`: このPCで動かす(node-llama-cpp。無料・素材が外に出ない。RTX の GPU があれば GPU で)
 * - `gemini`: Google の Gemini(鍵が要る。無料枠では送った内容がサービス改善に使われることがある)
 * - `off`: 使わない(構成は簡易の点数、演出テロップは提案しない)
 */
export type AiProvider = 'local' | 'gemini' | 'off'

export interface LlmRequest {
  prompt: string
  /** 出力の形(JSON スキーマ)。この形以外は生成できない */
  schema: Record<string, unknown>
  maxTokens?: number
}

export type LlmWorkerMessage =
  | { type: 'status'; stage: 'download' | 'load'; percent: number; note: string }
  | { type: 'device'; device: 'cuda' | 'vulkan' | 'metal' | 'cpu'; model: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; results: (unknown | null)[] }
  | { type: 'error'; message: string }

/**
 * GPU のメモリの量で、使うモデルを決める(4bit 量子化)。
 * 文字起こしのモデル(約3GB)と同時に載っても余裕がある大きさにする。
 */
export const LOCAL_MODELS = [
  {
    minVramGb: 16,
    uri: 'hf:Qwen/Qwen2.5-14B-Instruct-GGUF:Q4_K_M',
    label: 'Qwen2.5 14B',
    sizeGb: 9
  },
  {
    minVramGb: 7,
    uri: 'hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M',
    label: 'Qwen2.5 7B',
    sizeGb: 4.7
  },
  { minVramGb: 0, uri: 'hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M', label: 'Qwen2.5 7B', sizeGb: 4.7 }
] as const

export function chooseLocalModel(vramGb: number): (typeof LOCAL_MODELS)[number] {
  return LOCAL_MODELS.find((m) => vramGb >= m.minVramGb) ?? LOCAL_MODELS[LOCAL_MODELS.length - 1]
}

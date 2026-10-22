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

/**
 * GPU に載らずに CPU 側のメモリへ1度に確保してよい、モデルの重みの大きさ(GB)。
 * CPU だけで動かすと、3B(約2GB)以上の読み込みで Electron のメモリ確保(PartitionAlloc)の上限に当たり、
 * 解析のプロセスが落ちた(Linux で確認)。1.5B(約1GB)は読み込めた。
 */
export const CPU_SAFE_MODEL_GB = 1.5

/** 読み込みのほかに要るメモリの余裕(文脈の領域・作業用。GB) */
const RAM_MARGIN_GB = 1

export interface LocalModelLoadEnv {
  /** node-llama-cpp が選んだ GPU(`cuda` `vulkan` `metal`)。無ければ false */
  gpu: string | false
  /** GPU の空きメモリ(GB。GPU が無ければ 0) */
  vramFreeGb: number
  /** PC の空きメモリ(GB) */
  ramFreeGb: number
  /** モデルの大きさ(GB) */
  modelGb: number
  /** 画面に出すモデルの名前 */
  modelLabel: string
}

export type LocalModelLoadDecision = { ok: true } | { ok: false; reason: string }

const FALLBACK_HINT = '簡易の点数で続けます。GPU のあるPCで使うか、AI に Gemini を選んでください'

/**
 * このPCの AI のモデルを読み込んでよいか(読み込んで落ちる前に止める)。
 * GPU に載りきらない分は CPU 側に置かれるので、その大きさが `CPU_SAFE_MODEL_GB` を超えるなら読み込まない。
 * 空きメモリが足りないときも読み込まない。理由は利用者に出す一文。
 */
export function judgeLocalModelLoad(env: LocalModelLoadEnv): LocalModelLoadDecision {
  const gb = (n: number): string => `${Math.max(0, n).toFixed(1)}GB`
  const onGpu = Boolean(env.gpu)
  // GPU のメモリは少し余らせて見る(ほかの処理・画面も使う)
  const cpuPartGb = onGpu ? Math.max(0, env.modelGb - env.vramFreeGb * 0.9) : env.modelGb
  if (cpuPartGb > CPU_SAFE_MODEL_GB) {
    return {
      ok: false,
      reason: onGpu
        ? `GPU の空きメモリ(${gb(env.vramFreeGb)})が ${env.modelLabel}(約${gb(env.modelGb)})に足りず、このPCの AI を読み込むと落ちるおそれがあるため、${FALLBACK_HINT}`
        : `GPU が見つからず、CPU だけで ${env.modelLabel}(約${gb(env.modelGb)})を読み込むと落ちるおそれがあるため、${FALLBACK_HINT}`
    }
  }
  if (env.ramFreeGb < cpuPartGb + RAM_MARGIN_GB) {
    return {
      ok: false,
      reason: `PC の空きメモリ(${gb(env.ramFreeGb)})が足りず、このPCの AI(${env.modelLabel})を読み込めないため、簡易の点数で続けます。ほかのアプリを閉じるか、AI に Gemini を選んでください`
    }
  }
  return { ok: true }
}

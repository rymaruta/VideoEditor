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
  | {
      type: 'device'
      device: 'cuda' | 'vulkan' | 'metal' | 'cpu'
      model: string
      /** 読み込むモデルの URI(読み込みの途中で落ちたら、これを記録して次から試さない) */
      uri?: string
    }
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

/** 読み込みのほかに要るメモリの余裕(文脈の領域・OS・画面。GB) */
const MEMORY_MARGIN_GB = 1

export interface LocalModelLoadEnv {
  /** node-llama-cpp が選んだ GPU(`cuda` `vulkan` `metal`)。無ければ false */
  gpu: string | false
  /** GPU のメモリの総量(GB。GPU が無ければ 0) */
  vramTotalGb: number
  /** GPU のメモリが PC のメモリと同じもの(Apple Silicon など)。二重に数えない */
  unifiedMemory: boolean
  /** PC の物理メモリの総量(GB) */
  ramTotalGb: number
  /** モデルの大きさ(GB) */
  modelGb: number
  /** 画面に出すモデルの名前 */
  modelLabel: string
}

export type LocalModelLoadDecision = { ok: true } | { ok: false; reason: string }

/**
 * このPCの AI のモデルを、読み込む前に止めるか。**確実に読み込めないときだけ止める。**
 *
 * 読み込みは別プロセス(utilityProcess)なので、落ちてもアプリ本体は落ちない。そこで、空きメモリ
 * (macOS の `os.freemem()` は空きを小さく返す)や「GPU が無い」だけで止めず、まず試す。落ちたら
 * そのモデルを覚え、次からは試さない(`llmLoadFailures`。利用者が「もう一度試す」で試し直せる)。
 * 止めるのは、PC の物理メモリと GPU のメモリを合わせてもモデルより明らかに小さいときだけ。
 * 理由は場面を問わない一文(「簡易の点数で…」などの続きは呼び出し側が場面に合わせて付ける)。
 */
export function judgeLocalModelLoad(env: LocalModelLoadEnv): LocalModelLoadDecision {
  const gb = (n: number): string => `${Math.max(0, n).toFixed(1)}GB`
  const capacityGb =
    env.ramTotalGb + (env.gpu && !env.unifiedMemory ? Math.max(0, env.vramTotalGb) : 0)
  if (capacityGb < env.modelGb + MEMORY_MARGIN_GB) {
    return {
      ok: false,
      reason: `このPCのメモリ(${gb(capacityGb)})が AI のモデル(${env.modelLabel}・約${gb(env.modelGb)})より小さく、読み込めません`
    }
  }
  return { ok: true }
}

/** 前に読み込めなかったモデルを、今回は試さないときの一文 */
export function skippedModelMessage(modelLabel: string): string {
  return `このPCでは前回 AI(${modelLabel})を読み込めなかったので、今回は使いません(「このPCの AI をもう一度試す」で試し直せます)`
}

/** 読み込みの途中で解析のプロセスが落ちたときの一文 */
export function loadCrashedMessage(modelLabel: string): string {
  return `このPCでは AI(${modelLabel})を読み込めませんでした(次からはこのモデルを試しません)`
}

/** 読み込めなかったモデルの記録(userData/llm-load-failures.json) */
export interface LlmLoadFailure {
  /** モデルの URI(`hf:…`) */
  uri: string
  label: string
  /** 記録した時刻(ISO) */
  at: string
}

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
      /** GPU のメモリの総量(GB。記録の環境に使う) */
      vramGb?: number
      /** 読み込むモデルのファイル(読み込めなかったら、使わないので消す) */
      path?: string
    }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; results: (unknown | null)[] }
  | { type: 'error'; message: string }

/**
 * GPU のメモリの量で、使うモデルを決める(4bit 量子化)。
 * 文字起こしのモデル(約3GB)と同時に載っても余裕がある大きさにする。
 * GPU が無い PC は CPU 用の 1.5B(約1.1GB。CPU だけで読み込めた大きさ)。3B 以上は CPU だけでは
 * 読み込み中に落ちた(`CPU_SAFE_MODEL_GB`)。1.5B は判定の質が下がり、答えの形が崩れることもあるが、
 * 崩れた答えは出力の検査で捨てて、その場面・提案は簡易の判定で続ける(roughCutPlan)。
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

/** GPU が無い PC のモデル(Qwen2.5 1.5B Instruct・Q4_K_M・1,117,320,736 バイト。Apache-2.0) */
export const CPU_LOCAL_MODEL = {
  minVramGb: 0,
  uri: 'hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q4_K_M',
  label: 'Qwen2.5 1.5B',
  sizeGb: 1.1
} as const

export type LocalModel = (typeof LOCAL_MODELS)[number] | typeof CPU_LOCAL_MODEL

/** 使うモデル。`hasGpu` が false(GPU が無い)なら CPU 用の 1.5B */
export function chooseLocalModel(vramGb: number, hasGpu = true): LocalModel {
  if (!hasGpu) return CPU_LOCAL_MODEL
  return LOCAL_MODELS.find((m) => vramGb >= m.minVramGb) ?? LOCAL_MODELS[LOCAL_MODELS.length - 1]
}

/** 読み込みのほかに要るメモリの余裕(文脈の領域・OS・画面。GB) */
const MEMORY_MARGIN_GB = 1

/**
 * GPU の無い PC で読み込んでよいモデルの大きさ(GB)。CPU だけでは、3B(約2GB)以上の読み込みで
 * Electron のメモリ確保(PartitionAlloc)の上限に当たり、解析のプロセスが落ちた(Linux で確認)。
 * 1.5B(約1GB)は読み込めた。超えるモデルはダウンロードする前に止める(4.7GB を落としてから落ちない)
 */
export const CPU_SAFE_MODEL_GB = 1.5

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
 * このPCの AI のモデルを、読み込む前に止めるか。**読み込めないと分かっているときだけ止める。**
 *
 * 読み込みは別プロセス(utilityProcess)なので、落ちてもアプリ本体は落ちない。そこで、空きメモリ
 * (macOS の `os.freemem()` は空きを小さく返す)では止めず、まず試す。落ちたらそのモデルを覚え、
 * 次からは試さない(`llmLoadFailures`。利用者が「もう一度試す」で試し直せる)。
 * 止めるのは、GPU が無くて確かめた大きさ(`CPU_SAFE_MODEL_GB`)を超えるとき(ダウンロードの前に)と、
 * PC の物理メモリと GPU のメモリを合わせてもモデルより明らかに小さいときだけ。
 * 理由は場面を問わない一文(「簡易の点数で…」などの続きは呼び出し側が場面に合わせて付ける)。
 */
export function judgeLocalModelLoad(env: LocalModelLoadEnv): LocalModelLoadDecision {
  const gb = (n: number): string => `${Math.max(0, n).toFixed(1)}GB`
  if (!env.gpu && env.modelGb > CPU_SAFE_MODEL_GB) {
    return {
      ok: false,
      reason: `GPU が見つからず、CPU だけでは AI のモデル(${env.modelLabel}・約${gb(env.modelGb)})を読み込めないため使いません`
    }
  }
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
  /** 落ちたときの環境。どれかが変われば(版を上げた・GPU やメモリを足した)記録は効かない */
  env: LlmLoadEnvStamp
}

/** 読み込めなかったときの環境(アプリの版・GPU の種類・GPU のメモリ・PC のメモリ) */
export interface LlmLoadEnvStamp {
  appVersion: string
  gpu: string
  vramGb: number
  ramGb: number
}

/** 記録した環境が今と同じか(GPU・PC のメモリは 0.5GB 未満の違いを同じとみる) */
export function sameLoadEnv(a: LlmLoadEnvStamp, b: LlmLoadEnvStamp): boolean {
  return (
    a.appVersion === b.appVersion &&
    a.gpu === b.gpu &&
    Math.abs(a.vramGb - b.vramGb) < 0.5 &&
    Math.abs(a.ramGb - b.ramGb) < 0.5
  )
}

/** 使うモデルの選び方の結果。`note` は利用者に見せる一文(軽いモデルを使う理由) */
export type LocalModelPick =
  { kind: 'use'; model: LocalModel; note?: string } | { kind: 'skip'; label: string }

/**
 * 使うモデルを選ぶ。
 * - GPU が無い PC は CPU 用の 1.5B(「GPU が無いため軽いモデルを使います」)
 * - GPU のメモリで選んだモデル(7B・14B)が、同じ環境で前に読み込めなかったなら、1.5B に下げる
 *   (GPU のメモリが小さい PC で、二度と AI を使えなくならないように)
 * - 1.5B も前に読み込めなかったなら使わない(`skip`)
 */
export function pickLocalModel(input: {
  vramGb: number
  hasGpu: boolean
  failures: readonly LlmLoadFailure[]
  env: LlmLoadEnvStamp
}): LocalModelPick {
  const failed = (m: LocalModel): boolean =>
    input.failures.some((f) => f.uri === m.uri && sameLoadEnv(f.env, input.env))
  const choice = chooseLocalModel(input.vramGb, input.hasGpu)
  const light = `軽いモデル(${CPU_LOCAL_MODEL.label})`
  if (!failed(choice)) {
    return choice === CPU_LOCAL_MODEL && !input.hasGpu
      ? { kind: 'use', model: choice, note: `GPU が無いため${light}を使います` }
      : { kind: 'use', model: choice }
  }
  if (choice !== CPU_LOCAL_MODEL && !failed(CPU_LOCAL_MODEL))
    return {
      kind: 'use',
      model: CPU_LOCAL_MODEL,
      note: `このPCでは前回 ${choice.label} を読み込めなかったため、${light}を使います`
    }
  return { kind: 'skip', label: choice.label }
}

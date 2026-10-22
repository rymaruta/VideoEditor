import { childMain } from './childMain'
import { statSync } from 'fs'
import { totalmem } from 'os'
import {
  chooseLocalModel,
  judgeLocalModelLoad,
  sameLoadEnv,
  type LlmLoadFailure,
  skippedModelMessage,
  type LlmRequest,
  type LlmWorkerMessage
} from '@shared/llm'

const GB = 1024 ** 3

/**
 * このPCで言語モデルを動かす(node-llama-cpp)。別プロセス(理由は childMain)。
 * GPU は CUDA → Vulkan → なし の順に自動で選ぶ。モデルは初回だけダウンロードして userData/models に置く。
 * 出力は JSON スキーマから作った文法で縛るので、形の崩れた答えは出ない。
 *
 * 読み込みは別プロセス(utilityProcess)なので、ここで落ちてもアプリ本体は落ちない(llmService が理由を
 * 返し、そのモデルを覚えて次から試さない。呼び出し側は場面に合わせて簡易の判定で続ける)。
 * 読み込む前に止めるのは、確実に読み込めないときだけ(`judgeLocalModelLoad`)。
 */

interface WorkerInput {
  requests: LlmRequest[]
  cacheDir: string
  /** 指定があればこのモデル(テスト・設定用) */
  modelUri?: string
  /** 前にこのPCで読み込めなかったモデル(試さない) */
  skipModels?: LlmLoadFailure[]
  /** アプリの版(読み込めなかった記録の環境と比べる) */
  appVersion?: string
}

childMain<WorkerInput>(async (input, send) => {
  const post = (m: LlmWorkerMessage): void => send(m)
  const { getLlama, resolveModelFile, LlamaChatSession } = await import('node-llama-cpp')
  post({ type: 'status', stage: 'load', percent: 0, note: 'AI を準備中' })
  const llama = await getLlama({ gpu: 'auto' })
  const vramState = llama.gpu ? await llama.getVramState() : null
  const vram = vramState ? vramState.total / GB : 0
  const choice = chooseLocalModel(vram)
  const uri = input.modelUri ?? choice.uri
  const label = input.modelUri ? uri.replace(/^hf:/, '') : choice.label
  // 前に同じ環境(版・GPU・メモリ)で読み込めなかった(読み込み中に落ちた)モデルは試さない
  const env = {
    appVersion: input.appVersion ?? '',
    gpu: llama.gpu || 'cpu',
    vramGb: vram,
    ramGb: totalmem() / GB
  }
  if (input.skipModels?.some((f) => f.uri === uri && sameLoadEnv(f.env, env)))
    throw new Error(skippedModelMessage(label))
  // 読み込めないと分かっているとき(GPU が無くて大きい・メモリが明らかに足りない)だけ、読み込む前に
  // 止める。それ以外は試す(別プロセスなので、落ちても本体は落ちない)。決まったモデルはダウンロードの前に
  const ensureLoadable = (modelGb: number): void => {
    const decision = judgeLocalModelLoad({
      gpu: llama.gpu,
      vramTotalGb: vram,
      unifiedMemory: (vramState?.unifiedSize ?? 0) > 0,
      ramTotalGb: totalmem() / GB,
      modelGb,
      modelLabel: label
    })
    if (!decision.ok) throw new Error(decision.reason)
  }
  if (!input.modelUri) ensureLoadable(choice.sizeGb)
  const modelPath = await resolveModelFile(uri, {
    directory: input.cacheDir,
    cli: false,
    onProgress: ({ downloadedSize, totalSize }) =>
      post({
        type: 'status',
        stage: 'download',
        percent: totalSize > 0 ? (downloadedSize / totalSize) * 100 : 0,
        note: `AI のモデルをダウンロード中(初回のみ・${(totalSize / 1e9).toFixed(1)}GB)`
      })
  })
  // 指定のモデル(大きさが前もって分からない)は、取得したファイルの大きさで確かめる
  if (input.modelUri) ensureLoadable(statSync(modelPath).size / GB)
  // 読み込みの前に知らせる(読み込み中に落ちたとき、どの装置だったかで理由を示せるように)
  post({
    type: 'device',
    device: (llama.gpu || 'cpu') as 'cuda' | 'vulkan' | 'metal' | 'cpu',
    model: label,
    uri,
    vramGb: vram
  })
  post({ type: 'status', stage: 'load', percent: 50, note: 'AI のモデルを読み込み中' })
  const model = await llama.loadModel({ modelPath })
  const context = await model.createContext({
    contextSize: Math.min(16384, model.trainContextSize)
  })
  // 読み込み終わり(この後に落ちても、読み込めないモデルとしては覚えない)
  post({ type: 'status', stage: 'load', percent: 100, note: 'AI の準備ができました' })
  const results: (unknown | null)[] = []
  for (let i = 0; i < input.requests.length; i++) {
    const req = input.requests[i]
    // 1回目で答えが崩れたら(同じ言葉の繰り返しで長さが尽きるなど)、繰り返しを抑えてもう1回
    let answer: unknown | null = null
    for (let attempt = 0; attempt < 2 && answer === null; attempt++) {
      const sequence = context.getSequence()
      try {
        const session = new LlamaChatSession({ contextSequence: sequence })
        const grammar = await llama.createGrammarForJsonSchema(req.schema as never)
        const text = await session.prompt(req.prompt, {
          grammar,
          maxTokens: req.maxTokens ?? 4096,
          temperature: attempt === 0 ? 0.2 : 0.4,
          ...(attempt > 0
            ? { repeatPenalty: { penalty: 1.15, frequencyPenalty: 0.2, lastTokens: 128 } }
            : {})
        })
        answer = grammar.parse(text) as unknown
      } catch (e) {
        // 答えられなかった頼みは null(呼び出し側は簡易の判定で続ける)。理由は記録に残す
        console.error(
          `[llm] request ${i + 1} attempt ${attempt + 1} failed:`,
          e instanceof Error ? e.message : e
        )
      } finally {
        sequence.dispose()
      }
    }
    results.push(answer)
    post({ type: 'progress', done: i + 1, total: input.requests.length })
  }
  post({ type: 'done', results })
})

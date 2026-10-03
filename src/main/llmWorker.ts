import { childMain } from './childMain'
import { chooseLocalModel, type LlmRequest, type LlmWorkerMessage } from '@shared/llm'

/**
 * このPCで言語モデルを動かす(node-llama-cpp)。別プロセス(理由は childMain)。
 * GPU は CUDA → Vulkan → なし の順に自動で選ぶ。モデルは初回だけダウンロードして userData/models に置く。
 * 出力は JSON スキーマから作った文法で縛るので、形の崩れた答えは出ない。
 */

interface WorkerInput {
  requests: LlmRequest[]
  cacheDir: string
  /** 指定があればこのモデル(テスト・設定用) */
  modelUri?: string
}

childMain<WorkerInput>(async (input, send) => {
  const post = (m: LlmWorkerMessage): void => send(m)
  const { getLlama, resolveModelFile, LlamaChatSession } = await import('node-llama-cpp')
  post({ type: 'status', stage: 'load', percent: 0, note: 'AI を準備中' })
  const llama = await getLlama({ gpu: 'auto' })
  const vram = llama.gpu ? (await llama.getVramState()).total / 1024 ** 3 : 0
  const choice = chooseLocalModel(vram)
  const uri = input.modelUri ?? choice.uri
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
  post({ type: 'status', stage: 'load', percent: 50, note: 'AI のモデルを読み込み中' })
  const model = await llama.loadModel({ modelPath })
  const context = await model.createContext({
    contextSize: Math.min(16384, model.trainContextSize)
  })
  post({
    type: 'device',
    device: (llama.gpu || 'cpu') as 'cuda' | 'vulkan' | 'metal' | 'cpu',
    model: input.modelUri ? uri.replace(/^hf:/, '') : choice.label
  })
  const results: (unknown | null)[] = []
  for (let i = 0; i < input.requests.length; i++) {
    const req = input.requests[i]
    try {
      const sequence = context.getSequence()
      const session = new LlamaChatSession({ contextSequence: sequence })
      const grammar = await llama.createGrammarForJsonSchema(req.schema as never)
      const text = await session.prompt(req.prompt, {
        grammar,
        maxTokens: req.maxTokens ?? 4096,
        temperature: 0.2
      })
      results.push(grammar.parse(text))
      sequence.dispose()
    } catch {
      results.push(null)
    }
    post({ type: 'progress', done: i + 1, total: input.requests.length })
  }
  post({ type: 'done', results })
})

import { childMain } from './childMain'
import { readWindow } from './audioPcm'
import {
  asrGroupResults,
  averageProbs,
  groupAsrJobs,
  languageProbes,
  languageProbs,
  markSegmentStarts,
  type AsrRawChunk,
  type GroupedJob
} from '@shared/diarize/groupJobs'
import {
  chooseAsrLanguage,
  withLanguageFallback,
  DEFAULT_ASR_LANGUAGE,
  ASR_MODEL_ID,
  asrDeviceOrder,
  type AsrDevice,
  type AsrJob,
  type AsrLanguage,
  type AsrWorkerMessage
} from '@shared/transcript'

/**
 * 音声認識(計画書 §5.3)を別スレッドで行う。モデルは whisper-large-v3-turbo(単語の時刻つき)。
 *
 * GPU から順に試し、読み込みと試しの認識に失敗したら次へ落とす:
 *   Windows: DirectML(NVIDIA/AMD/Intel の GPU) → CPU
 *   それ以外: CPU
 * GPU では fp16、CPU では 4bit に量子化したモデルを使う(CPU は遅いが、精度はほぼ同じ)。
 *
 * 実測(この開発環境の CPU、4bit): 3〜5 秒の発話1本に 6〜7 秒。GPU 前提の工程。
 */

interface WorkerInput {
  jobs: AsrJob[]
  ffmpegPath: string
  cacheDir: string
  /** 指定があればその順に試す(テスト・設定用) */
  devices?: AsrDevice[]
  /** 話している言語。`auto` は素材ごとに判定する。省略は日本語(今までどおり) */
  language?: AsrLanguage
}

let input: WorkerInput
let post: (m: AsrWorkerMessage) => void

const SAMPLE_RATE = 16000

const DTYPES: Record<AsrDevice, Record<string, string>> = {
  dml: { encoder_model: 'fp16', decoder_model_merged: 'fp16' },
  cuda: { encoder_model: 'fp16', decoder_model_merged: 'fp16' },
  cpu: { encoder_model: 'q4', decoder_model_merged: 'q4' }
}

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>
) => Promise<{ text: string; chunks?: AsrRawChunk[] }>

const OPTIONS = {
  language: 'japanese',
  task: 'transcribe',
  return_timestamps: 'word',
  chunk_length_s: 30
}

interface WhisperParts {
  model?: ((
    inputs: Record<string, unknown>
  ) => Promise<{ logits: { data: ArrayLike<number>; dims: number[] } }>) & {
    generation_config?: { decoder_start_token_id?: number; lang_to_id?: Record<string, number> }
  }
  processor?: (audio: Float32Array) => Promise<{ input_features: unknown }>
}

/**
 * 窓の音の言語を判定する(Whisper の最初の言葉=言語の印の確からしさ)。transformers.js は言語を
 * 指定しないと英語にしてしまう(判定しない)ので、エンコーダと最初の1語だけを自分で計算する。
 * 判定できなければ null
 */
async function detectLanguage(
  asr: Transcriber,
  audio: Float32Array
): Promise<Map<string, number> | null> {
  const { model, processor } = asr as unknown as WhisperParts
  const config = model?.generation_config
  if (!model || !processor || !config?.lang_to_id || config.decoder_start_token_id === undefined)
    return null
  const { Tensor } = await import('@huggingface/transformers')
  const { input_features } = await processor(audio)
  const out = await model({
    input_features,
    decoder_input_ids: new Tensor(
      'int64',
      BigInt64Array.from([BigInt(config.decoder_start_token_id)]),
      [1, 1]
    )
  })
  const vocab = out.logits.dims[out.logits.dims.length - 1]
  const data = out.logits.data
  const last = Array.from({ length: vocab }, (_, i) => data[data.length - vocab + i])
  const probs = languageProbs(last, config.lang_to_id)
  return probs.size > 0 ? probs : null
}

async function loadTranscriber(): Promise<{ asr: Transcriber; device: AsrDevice }> {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = input.cacheDir
  const order: AsrDevice[] = input.devices ?? asrDeviceOrder(process.platform)
  const failures: string[] = []
  const files = new Map<string, { loaded: number; total: number }>()
  for (const device of order) {
    try {
      post({
        type: 'status',
        stage: 'load',
        percent: 0,
        note: `モデルを準備中(${device === 'cpu' ? 'CPU' : 'GPU'})`
      })
      const asr = (await pipeline('automatic-speech-recognition', ASR_MODEL_ID, {
        device,
        dtype: DTYPES[device],
        progress_callback: (p: {
          status?: string
          file?: string
          loaded?: number
          total?: number
        }) => {
          if (p.status !== 'progress' || !p.file || !p.total) return
          files.set(p.file, { loaded: p.loaded ?? 0, total: p.total })
          let loaded = 0
          let total = 0
          for (const f of files.values()) {
            loaded += f.loaded
            total += f.total
          }
          post({
            type: 'status',
            stage: 'download',
            percent: total > 0 ? (loaded / total) * 100 : 0,
            note: `モデルをダウンロード中(初回のみ・${(total / 1e9).toFixed(1)}GB)`
          })
        }
      } as Record<string, unknown>)) as unknown as Transcriber
      // 読み込めても、実際に計算させると落ちる GPU がある(対応していない演算など)。1秒の無音で試す
      await asr(new Float32Array(SAMPLE_RATE), OPTIONS)
      // 認識の区切りの頭の片に印を付ける(日本語に固定して英語を認識すると、区切りの間の空白が消える)
      markSegmentStarts(asr)
      return { asr, device }
    } catch (e) {
      failures.push(`${device}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new Error(`音声認識のモデルを読み込めませんでした — ${failures.join(' / ')}`)
}

async function run(): Promise<void> {
  const { asr, device } = await loadTranscriber()
  post({
    type: 'device',
    device,
    note:
      input.devices === undefined && process.platform === 'win32' && device === 'cpu'
        ? 'GPU を使えなかったため CPU で認識します(時間がかかります)'
        : undefined
  })
  // 同じマイクで続く発話はまとめて読む(窓の数が減って速い)。次の窓の音は、今の窓の認識中に読んでおく
  const groups = groupAsrJobs(input.jobs)
  const read = (g: GroupedJob): Promise<Float32Array> =>
    readWindow(input.ffmpegPath, g.path, g.start, g.end - g.start, SAMPLE_RATE)
  // 素材(マイク)ごとの言語。自動なら、声の多い窓を少し読んで判定する(1つの素材の中では変えない。
  // 窓ごとに判定すると、短い相づち・笑いの窓で言語が揺れる)
  const chosen = input.language ?? DEFAULT_ASR_LANGUAGE
  const languageOf = new Map<string, string>()
  if (chosen === 'auto') {
    for (const [path, probes] of languageProbes(groups)) {
      post({ type: 'status', stage: 'load', percent: 0, note: '話している言語を判定中' })
      const found: Map<string, number>[] = []
      for (const g of probes) {
        try {
          const p = await detectLanguage(asr, await read(g))
          if (p) found.push(p)
        } catch {
          // 判定できない窓は飛ばす(全部だめなら日本語)
        }
      }
      const lang = chooseAsrLanguage(averageProbs(found))
      languageOf.set(path, lang)
      post({
        type: 'status',
        stage: 'load',
        percent: 0,
        note: `話している言語: ${lang}(${path.split(/[/\\]/).pop() ?? path})`
      })
    }
  }
  const optionsFor = (g: GroupedJob): typeof OPTIONS =>
    chosen === 'auto'
      ? { ...OPTIONS, language: languageOf.get(g.path) ?? 'ja' }
      : { ...OPTIONS, language: chosen }
  let done = 0
  let next = groups.length > 0 ? read(groups[0]) : null
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]
    const audio = await next!
    next = gi + 1 < groups.length ? read(groups[gi + 1]) : null
    // 先読みが今の認識中に失敗しても「処理されない失敗」にしない(次の周の await で失敗として扱う)
    next?.catch(() => {})
    const options = optionsFor(group)
    const r = await withLanguageFallback(options.language, (language) =>
      asr(audio, { ...options, language })
    )
    for (const result of asrGroupResults(group, r.text ?? '', r.chunks ?? []))
      post({ type: 'result', result })
    done += group.parts.length
    post({ type: 'progress', done, total: input.jobs.length })
  }
  post({ type: 'done' })
}

childMain<WorkerInput>(async (data, send) => {
  input = data
  post = send
  await run()
})

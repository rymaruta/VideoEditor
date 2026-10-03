import { childMain } from './childMain'
import { readWindow } from './audioPcm'
import type { AsrDevice, AsrJob, AsrWorkerMessage } from '@shared/transcript'

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
}

let input: WorkerInput
let post: (m: AsrWorkerMessage) => void

export const ASR_MODEL_ID = 'onnx-community/whisper-large-v3-turbo_timestamped'
const SAMPLE_RATE = 16000

const DTYPES: Record<AsrDevice, Record<string, string>> = {
  dml: { encoder_model: 'fp16', decoder_model_merged: 'fp16' },
  cuda: { encoder_model: 'fp16', decoder_model_merged: 'fp16' },
  cpu: { encoder_model: 'q4', decoder_model_merged: 'q4' }
}

interface AsrChunk {
  text: string
  timestamp: [number, number | null]
}
type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>
) => Promise<{ text: string; chunks?: AsrChunk[] }>

const OPTIONS = {
  language: 'japanese',
  task: 'transcribe',
  return_timestamps: 'word',
  chunk_length_s: 30
}

async function loadTranscriber(): Promise<{ asr: Transcriber; device: AsrDevice }> {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = input.cacheDir
  const order: AsrDevice[] =
    input.devices ?? (process.platform === 'win32' ? ['dml', 'cpu'] : ['cpu'])
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
  let done = 0
  for (const job of input.jobs) {
    const audio = await readWindow(
      input.ffmpegPath,
      job.path,
      job.start,
      job.end - job.start,
      SAMPLE_RATE
    )
    const r = await asr(audio, OPTIONS)
    const words = (r.chunks ?? [])
      .map((c) => ({
        text: c.text.trim(),
        start: job.start + c.timestamp[0],
        end: job.start + (c.timestamp[1] ?? c.timestamp[0])
      }))
      .filter((w) => w.text.length > 0)
    post({ type: 'result', result: { id: job.id, text: (r.text ?? '').trim(), words } })
    post({ type: 'progress', done: ++done, total: input.jobs.length })
  }
  post({ type: 'done' })
}

childMain<WorkerInput>(async (data, send) => {
  input = data
  post = send
  await run()
})

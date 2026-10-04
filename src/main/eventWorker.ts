import { spawn } from 'child_process'
import { childMain } from './childMain'
import {
  EVENT_HOP_SEC,
  EVENT_WINDOW_SEC,
  eventScores,
  type AudioEventWindow
} from '@shared/events/audioEvents'

/**
 * 笑い・歓声の検出(計画書 §5.5)を別プロセスで行う。モデルは AudioSet で学習した AST(BSD-3-Clause)。
 * 音は ffmpeg から流しながら読み(4時間でも全部をメモリに載せない)、10 秒の窓を 5 秒ずつずらして調べる。
 * GPU(Windows は DirectML)を先に試し、使えなければ CPU(8bit に量子化したモデル)。
 * 実測(この開発環境の CPU): 10 秒の窓1つに約 0.3 秒。
 */
export const EVENT_MODEL_ID = 'Xenova/ast-finetuned-audioset-10-10-0.4593'
const SAMPLE_RATE = 16000

type Device = 'dml' | 'cuda' | 'cpu'
const DTYPE: Record<Device, string> = { dml: 'fp16', cuda: 'fp16', cpu: 'q8' }

interface WorkerInput {
  /** 調べる音(基準カメラの素材)。start / rate は共通の時間軸への換算 */
  files: { path: string; start: number; rate: number; duration: number }[]
  ffmpegPath: string
  cacheDir: string
  devices?: Device[]
}

/** 10 秒の音 → 分類ごとの確からしさ(シグモイド。多ラベルなので合計 1 にはしない) */
type Classifier = (audio: Float32Array) => Promise<{ label: string; score: number }[]>

export type EventWorkerMessage =
  | { type: 'status'; note: string; percent: number }
  | { type: 'device'; device: Device }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; events: AudioEventWindow[] }
  | { type: 'error'; message: string }

async function loadClassifier(
  input: WorkerInput,
  post: (m: EventWorkerMessage) => void
): Promise<{ clf: Classifier; device: Device }> {
  const { AutoProcessor, AutoModelForAudioClassification, env } =
    await import('@huggingface/transformers')
  env.cacheDir = input.cacheDir
  const order: Device[] = input.devices ?? (process.platform === 'win32' ? ['dml', 'cpu'] : ['cpu'])
  const failures: string[] = []
  for (const device of order) {
    try {
      post({
        type: 'status',
        note: `モデルを準備中(${device === 'cpu' ? 'CPU' : 'GPU'})`,
        percent: 0
      })
      const processor = await AutoProcessor.from_pretrained(EVENT_MODEL_ID)
      const model = await AutoModelForAudioClassification.from_pretrained(EVENT_MODEL_ID, {
        device,
        dtype: DTYPE[device]
      } as Record<string, unknown>)
      const labels = (model.config as unknown as { id2label: Record<number, string> }).id2label
      const clf: Classifier = async (audio) => {
        const { logits } = (await model(await processor(audio))) as {
          logits: { data: Float32Array }
        }
        return Array.from(logits.data, (x, i) => ({
          label: labels[i],
          score: 1 / (1 + Math.exp(-x))
        }))
      }
      await clf(new Float32Array(SAMPLE_RATE))
      return { clf, device }
    } catch (e) {
      failures.push(`${device}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new Error(`笑い・歓声の検出のモデルを読み込めませんでした — ${failures.join(' / ')}`)
}

childMain<WorkerInput>(async (input, send) => {
  const post = (m: EventWorkerMessage): void => send(m)
  const { clf, device } = await loadClassifier(input, post)
  post({ type: 'device', device })
  const win = EVENT_WINDOW_SEC * SAMPLE_RATE
  const hop = EVENT_HOP_SEC * SAMPLE_RATE
  const totalSec = input.files.reduce((t, f) => t + f.duration, 0)
  let doneSec = 0
  const events: AudioEventWindow[] = []
  for (const f of input.files) {
    const child = spawn(
      input.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-i',
        f.path,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-f',
        'f32le',
        'pipe:1'
      ],
      { windowsHide: true }
    )
    // 標準エラーは読み続ける(読まないと、壊れた素材でエラーが溜まって ffmpeg が書けずに止まり、
    // こちらの読み出しも終わらない)。末尾だけ持っておき、失敗の理由にする
    let errTail = ''
    child.stderr.on('data', (c: Buffer) => {
      errTail = (errTail + c.toString()).slice(-2000)
    })
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
    let buf: Buffer = Buffer.alloc(0)
    let offset = 0 // この素材の何サンプル目から始まる窓か
    const classify = async (bytes: Buffer, samples: number): Promise<void> => {
      const audio = new Float32Array(win)
      audio.set(
        new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + samples * 4))
      )
      const r = await clf(audio)
      const { laugh, cheer } = eventScores(r)
      const startSec = offset / SAMPLE_RATE
      events.push({
        start: f.start + startSec / f.rate,
        end: f.start + (startSec + samples / SAMPLE_RATE) / f.rate,
        laugh: Math.round(laugh * 1000) / 1000,
        cheer: Math.round(cheer * 1000) / 1000
      })
    }
    // `for await` で読むので、窓を調べている間は ffmpeg からの読み出しが止まる(メモリが膨らまない)
    for await (const chunk of child.stdout) {
      buf = buf.length ? Buffer.concat([buf, chunk as Buffer]) : (chunk as Buffer)
      while (buf.length >= win * 4) {
        await classify(buf.subarray(0, win * 4), win)
        buf = buf.subarray(hop * 4)
        offset += hop
        post({
          type: 'progress',
          done: Math.round(doneSec + offset / SAMPLE_RATE),
          total: Math.round(totalSec)
        })
      }
    }
    // 音が読めなかった(音声の無い素材・壊れた素材)のに「笑い 0 回」とは言わない
    const code = await exited
    if (code !== 0)
      throw new Error(
        `${f.path} の音を読めませんでした(終了コード ${code})${errTail ? `: ${errTail.trim().split('\n').pop()}` : ''}`
      )
    // 最後の半端(3 秒以上あれば調べる)
    const rest = Math.floor(buf.length / 4)
    if (rest >= 3 * SAMPLE_RATE) await classify(buf, rest)
    doneSec += f.duration
  }
  post({ type: 'done', events })
})

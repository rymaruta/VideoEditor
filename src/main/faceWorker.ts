import { childMain } from './childMain'
import { spawn } from 'child_process'
import { decodeYunet, YUNET_SIZE } from './yunet'
import type { FaceBox } from '@shared/telop/avoidFaces'

/**
 * 顔の検出(計画書 §5.8 の顔を避ける配置、§5.7 のアングルの採点に使う)。
 * 指定の素材・時刻の画を1枚取り出し、YuNet で顔を探す。枠は画面に対する比(0〜1)で返す。
 */

interface FaceRequest {
  path: string
  time: number
  width: number
  height: number
}

interface WorkerInput {
  requests: FaceRequest[]
  ffmpegPath: string
  modelPath: string
}

let input: WorkerInput
let post: (m: unknown) => void

function frameBgr(req: FaceRequest, w: number, h: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      input.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-ss',
        Math.max(0, req.time).toFixed(3),
        '-i',
        req.path,
        '-frames:v',
        '1',
        '-vf',
        `scale=${w}:${h},pad=${YUNET_SIZE}:${YUNET_SIZE}:0:0`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'bgr24',
        'pipe:1'
      ],
      { windowsHide: true }
    )
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg ${code}`))
    )
  })
}

async function run(): Promise<void> {
  const ort = await import('onnxruntime-node')
  const session = await ort.InferenceSession.create(input.modelPath)
  const results: (FaceBox[] | null)[] = []
  const plane = YUNET_SIZE * YUNET_SIZE
  for (let k = 0; k < input.requests.length; k++) {
    const req = input.requests[k]
    try {
      // 長い辺を 640 に合わせ、残りは黒で埋める(縦横比を保つ)
      const scale = YUNET_SIZE / Math.max(req.width, req.height)
      const w = Math.max(2, Math.round((req.width * scale) / 2) * 2)
      const h = Math.max(2, Math.round((req.height * scale) / 2) * 2)
      const raw = await frameBgr(req, w, h)
      if (raw.length < plane * 3) throw new Error('画を取り出せませんでした')
      const data = new Float32Array(3 * plane)
      for (let i = 0; i < plane; i++) {
        data[i] = raw[i * 3]
        data[plane + i] = raw[i * 3 + 1]
        data[2 * plane + i] = raw[i * 3 + 2]
      }
      const out = await session.run({
        input: new ort.Tensor('float32', data, [1, 3, YUNET_SIZE, YUNET_SIZE])
      })
      results.push(
        decodeYunet(out as never).map((b) => ({
          x: b.x / w,
          y: b.y / h,
          w: b.w / w,
          h: b.h / h,
          score: b.score
        }))
      )
    } catch {
      results.push(null)
    }
    post({ type: 'progress', done: k + 1, total: input.requests.length })
  }
  post({ type: 'done', results })
}

childMain<WorkerInput>(async (data, send) => {
  input = data
  post = send
  await run()
})

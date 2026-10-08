import { trackUntilDone } from './liveProcesses'
import { spawn } from 'child_process'
import { ffmpegPath } from './ffmpegService'

/**
 * 素材の1枚を小さな RGB(rgb24)で読む。色の統計(色合わせ)に使う。読めなければ null。
 * 縦横比は見ない(色の分布は変わらない)。
 */
function frameRgb(path: string, time: number, w: number, h: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-ss',
        Math.max(0, time).toFixed(3),
        '-i',
        path,
        '-frames:v',
        '1',
        '-vf',
        `scale=${w}:${h}`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1'
      ],
      { windowsHide: true }
    )
    trackUntilDone(child)
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      const buf = Buffer.concat(chunks)
      resolve(code === 0 && buf.length === w * h * 3 ? new Uint8Array(buf) : null)
    })
  })
}

/** まとめて読む(同時に4本まで) */
export async function readFramesRgb(
  requests: { path: string; time: number }[],
  size: { w: number; h: number },
  onProgress: (done: number, total: number) => void
): Promise<(Uint8Array | null)[]> {
  const out: (Uint8Array | null)[] = new Array(requests.length).fill(null)
  let next = 0
  let done = 0
  const worker = async (): Promise<void> => {
    while (next < requests.length) {
      const i = next++
      out[i] = await frameRgb(requests[i].path, requests[i].time, size.w, size.h)
      onProgress(++done, requests.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, worker))
  return out
}

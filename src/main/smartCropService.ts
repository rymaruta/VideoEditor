import { trackUntilDone } from './liveProcesses'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bestWindowCenter } from '@shared/cropWindow'
import { ffmpegPath } from './ffmpegService'
import { ffSeconds } from './ffArgs'

const execFileAsyncRaw = promisify(execFile)
/** 外部の処理を始め、アプリを閉じるときに止める一覧に入れる */
const execFileAsync = (
  file: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> => {
  const p = execFileAsyncRaw(file, args)
  trackUntilDone(p.child)
  return p
}

const SAMPLE_COUNT = 6
const SAMPLE_WIDTH = 160

// Async on purpose: this runs six times per invocation, and a synchronous ffmpeg
// call blocks the whole main process (every IPC, dialog, even the close button).
async function extractRawFrame(
  filePath: string,
  atSeconds: number,
  w: number,
  h: number
): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 've-crop-'))
  const outPath = join(dir, 'frame.raw')
  try {
    await execFileAsync(ffmpegPath, [
      '-y',
      '-ss',
      ffSeconds(atSeconds),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${w}:${h}`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      outPath
    ])
    return readFileSync(outPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function columnEnergy(frame: Buffer, w: number, h: number): number[] {
  const energy = new Array<number>(w).fill(0)
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const i = (y * w + x) * 3
      const iPrev = (y * w + (x - 1)) * 3
      energy[x] +=
        Math.abs(frame[i] - frame[iPrev]) +
        Math.abs(frame[i + 1] - frame[iPrev + 1]) +
        Math.abs(frame[i + 2] - frame[iPrev + 2])
    }
  }
  return energy
}

function rowEnergy(frame: Buffer, w: number, h: number): number[] {
  const energy = new Array<number>(h).fill(0)
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const iPrev = ((y - 1) * w + x) * 3
      energy[y] +=
        Math.abs(frame[i] - frame[iPrev]) +
        Math.abs(frame[i + 1] - frame[iPrev + 1]) +
        Math.abs(frame[i + 2] - frame[iPrev + 2])
    }
  }
  return energy
}

/**
 * Estimates a crop center that keeps the visually busiest region of the frame in view,
 * as a lightweight stand-in for real subject detection (no ML model / extra deps required).
 * Averages edge-energy profiles across several sampled frames to reduce single-frame noise.
 */
export async function analyzeSmartCropCenter(
  filePath: string,
  rangeStart: number,
  rangeEnd: number,
  sourceWidth: number,
  sourceHeight: number,
  targetAspect: number
): Promise<{ x: number; y: number }> {
  if (!sourceWidth || !sourceHeight) return { x: 0.5, y: 0.5 }
  const sourceAspect = sourceWidth / sourceHeight
  const cropHorizontal = sourceAspect > targetAspect
  const sampleW = SAMPLE_WIDTH
  const sampleH = Math.max(2, Math.round(SAMPLE_WIDTH / sourceAspect))

  const duration = Math.max(0.1, rangeEnd - rangeStart)
  const timestamps = Array.from(
    { length: SAMPLE_COUNT },
    (_, i) => rangeStart + ((i + 0.5) / SAMPLE_COUNT) * duration
  )

  const energies: number[][] = []
  const frameBytes = sampleW * sampleH * 3
  for (const t of timestamps) {
    try {
      const frame = await extractRawFrame(filePath, t, sampleW, sampleH)
      // 映像ストリームが尽きた位置(容器の尺より映像が短い録画物の尾や EOF 直前)では、
      // ffmpeg は**終了コード0のまま0バイトの出力**を書くので catch に来ない(実測)。
      // 足りないバッファを energy 計算へ通すと添字外読みが NaN を作り、平均が全列
      // NaN になって**測れた他のフレームの情報ごと捨てられる**(bestWindowCenter は
      // NaN を 0 と読むので、結果は必ず中央 0.5 に戻る)。取れなかったフレームとして
      // 読み飛ばす(catch と同じ扱い)。
      if (frame.length < frameBytes) continue
      energies.push(
        cropHorizontal ? columnEnergy(frame, sampleW, sampleH) : rowEnergy(frame, sampleW, sampleH)
      )
    } catch {
      // Skip frames ffmpeg couldn't extract (e.g. right at EOF); a few dropped samples are fine.
    }
  }
  if (energies.length === 0) return { x: 0.5, y: 0.5 }

  const length = energies[0].length
  const avg = new Array<number>(length).fill(0)
  for (const e of energies) {
    for (let i = 0; i < length; i++) avg[i] += e[i] / energies.length
  }

  const windowFraction = cropHorizontal ? targetAspect / sourceAspect : sourceAspect / targetAspect
  const center = bestWindowCenter(avg, windowFraction)
  return cropHorizontal ? { x: center, y: 0.5 } : { x: 0.5, y: center }
}

import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, ffprobePath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { stackTopHeight } from '@shared/videoFrame'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 2人を上下に積む縦の書き出し(試し編集 第3回の N1)を、同梱の ffmpeg で実際に書き出して確かめる。
 * 素材は 640x360 の灰色に、左の人(赤の箱)と右の人(青の箱)。上の段に赤、下の段に青が映り、
 * 1080x1920 の枠いっぱい(黒帯なし)で、標準と区間ごとの書き出しの両方で同じになる
 */
const HAVE_FFMPEG = existsSync(ffmpegPath) && existsSync(ffprobePath)

let work = ''
let asset: MediaAsset

function ff(args: string[]): Buffer {
  return execFileSync(ffmpegPath, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 28 })
}

/** 書き出した動画の 1 秒の所の1枚を、小さな RGB で読む */
function frameAt(path: string, w: number, h: number): Uint8Array {
  return new Uint8Array(
    ff([
      '-ss',
      '1',
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
    ])
  )
}

/** 画の帯(縦 y0〜y1 の比)の真ん中あたりの平均の色 */
function meanColor(f: Uint8Array, w: number, h: number, y0: number, y1: number): number[] {
  const sum = [0, 0, 0]
  let n = 0
  for (let y = Math.floor(h * y0); y < Math.floor(h * y1); y++)
    for (let x = Math.floor(w * 0.3); x < Math.floor(w * 0.7); x++) {
      for (let c = 0; c < 3; c++) sum[c] += f[(y * w + x) * 3 + c]
      n++
    }
  return sum.map((s) => s / n)
}

beforeAll(async () => {
  if (!HAVE_FFMPEG) return
  work = mkdtempSync(join(tmpdir(), 've-stack-'))
  const path = join(work, 'talk.mp4')
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=640x360:r=30:d=2,drawbox=x=40:y=60:w=160:h=240:color=red:t=fill,' +
      'drawbox=x=440:y=60:w=160:h=240:color=blue:t=fill,format=yuv420p',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo:d=2',
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    path
  ])
  const probe = await probeMedia(path)
  asset = {
    id: 'A',
    filePath: path,
    fileName: 'talk.mp4',
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    hasAudio: probe.hasAudio,
    hasVideo: probe.hasVideo
  }
}, 60_000)

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true })
})

describe.skipIf(!HAVE_FFMPEG)('2人を上下に積む縦の書き出し(実際の ffmpeg)', () => {
  const project = (): Project =>
    ({
      id: 'p',
      name: 'stack',
      aspectRatio: '9:16',
      assets: [asset],
      clips: [
        {
          id: 'c1',
          assetId: 'A',
          inPoint: 0,
          outPoint: 2,
          speed: 1,
          fillCrop: true,
          cropCenter: { x: 0.19, y: 0.5 },
          // 左の人(赤: 素材の x 0.06〜0.31)と右の人(青: x 0.69〜0.94)。窓は 9:8
          splitStack: {
            top: { x: 0.03, y: 0.1, w: 0.32, h: (0.32 * (640 / 360)) / (9 / 8) },
            bottom: { x: 0.65, y: 0.1, w: 0.32, h: (0.32 * (640 / 360)) / (9 / 8) }
          }
        }
      ],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: []
    }) as unknown as Project

  for (const engine of ['standard', 'segmented'] as const)
    it(`上の段に左の人、下の段に右の人(${engine})`, async () => {
      const out = join(work, `${engine}.mp4`)
      if (engine === 'standard')
        await exportProject({
          project: project(),
          aspectRatio: '9:16',
          resolutionHeight: 1080,
          quality: 'standard',
          outputPath: out,
          telopLayer: null,
          onProgress: () => {}
        })
      else
        await exportSequenceSegmented({
          project: projectV1ToV2(project(), { resolution: 1080 }),
          outputPath: out,
          quality: 'standard',
          encoder: 'libx264',
          telopLayer: null
        })
      const probe = await probeMedia(out)
      expect(probe.width).toBe(1080)
      expect(probe.height).toBe(1920)
      expect(probe.duration).toBeCloseTo(2, 1)
      // 上下を積む所で最後の1コマが落ちない(2 秒 × 30fps)
      const frames = execFileSync(ffprobePath, [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=nb_read_frames',
        '-of',
        'csv=p=0',
        out
      ])
        .toString()
        .trim()
      expect(Number(frames)).toBe(60)
      const w = 54
      const h = 96
      const f = frameAt(out, w, h)
      const seam = stackTopHeight(1920) / 1920
      const top = meanColor(f, w, h, 0.15, seam - 0.1)
      const bottom = meanColor(f, w, h, seam + 0.1, 0.85)
      // 上は赤、下は青(黒帯ではない)
      expect(top[0]).toBeGreaterThan(150)
      expect(top[2]).toBeLessThan(90)
      expect(bottom[2]).toBeGreaterThan(150)
      expect(bottom[0]).toBeLessThan(90)
    }, 120_000)
})

import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, ffprobePath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { applyVerticalFill } from '@renderer/lib/verticalFraming'
import type { FaceBox } from '@shared/telop/avoidFaces'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 話している人へ切り替えるとき、クリップを分けた所で音が途切れない・飛ばない(監査の指摘 1)。
 * 前は切り替えの素材の位置を、コマに丸める前のクリップの頭から数えていたので、書き出し(クリップの頭を
 * コマに丸めて素材を読む)で最大半コマずれ、1本目が 1.01 秒のとき切り替えの直前に約 10ms の無音、
 * 1.0167 秒のとき約 16ms の音飛びが出た。分けた書き出しと分けない書き出しの音を、実際の ffmpeg で比べる
 */
const HAVE_FFMPEG = existsSync(ffmpegPath) && existsSync(ffprobePath)
const RATE = 48000

let work = ''
let asset: MediaAsset

function ff(args: string[]): Buffer {
  return execFileSync(ffmpegPath, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 28 })
}

function pcm(path: string): Int16Array {
  const b = ff(['-i', path, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'])
  return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2))
}

const face = (x: number): FaceBox => ({ x, y: 0.3, w: 0.08, h: 0.128, score: 0.9 })

beforeAll(async () => {
  if (!HAVE_FFMPEG) return
  work = mkdtempSync(join(tmpdir(), 've-switch-'))
  const path = join(work, 'talk.mp4')
  // 音は上がっていく音(時刻ごとに波の形が違うので、ずれ・途切れが差に出る)
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=640x360:r=30:d=6,format=yuv420p',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=exprs='0.4*sin(2*PI*(300+200*t)*t)':s=${RATE}:d=6`,
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'pcm_s16le',
    join(work, 'talk.mov')
  ])
  ff(['-i', join(work, 'talk.mov'), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', path])
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

describe.skipIf(!HAVE_FFMPEG)('話す人の切り替えで分けた所の音(実際の ffmpeg)', () => {
  const project = (first: number): Project =>
    ({
      id: 'p',
      name: 'switch',
      aspectRatio: '9:16',
      assets: [asset],
      clips: [
        { id: 'c0', assetId: 'A', inPoint: 0, outPoint: first, speed: 1 },
        { id: 'c1', assetId: 'A', inPoint: first, outPoint: 5.5, speed: 1 }
      ],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: []
    }) as unknown as Project
  const faces = new Map(
    ['c0', 'c1'].map((id) => [
      id,
      [1, 3, 5].map((time) => ({ time, faces: [face(0.15), face(0.75)] }))
    ])
  )

  for (const first of [1.01, 1.0167])
    for (const engine of ['standard', 'segmented'] as const)
      it(`1本目 ${first} 秒・${engine}: 分けた所で音が途切れず飛ばない`, async () => {
        const p = project(first)
        // 1本目の終わりから右の人(乙)、3.0167 秒から左の人(甲)
        const lines = [
          { speaker: '乙', start: first, end: 3.0 },
          { speaker: '甲', start: 3.0167, end: 5.5 }
        ]
        const split = applyVerticalFill(p, faces, {
          speakers: {
            faces: new Map([
              [
                'A',
                new Map([
                  ['甲', 0.19],
                  ['乙', 0.79]
                ])
              ]
            ]),
            lines
          }
        }).project
        const whole = applyVerticalFill(p, faces).project
        expect(split.clips.length).toBe(3)
        expect(whole.clips.length).toBe(2)
        const run = async (proj: Project, name: string): Promise<Int16Array> => {
          const out = join(work, `${name}.mp4`)
          if (engine === 'standard')
            await exportProject({
              project: proj,
              aspectRatio: '9:16',
              resolutionHeight: 480,
              quality: 'standard',
              outputPath: out,
              telopLayer: null,
              onProgress: () => {}
            })
          else
            await exportSequenceSegmented({
              project: projectV1ToV2(proj, { resolution: 480 }),
              outputPath: out,
              quality: 'standard',
              encoder: 'libx264',
              telopLayer: null
            })
          return pcm(out)
        }
        const a = await run(split, `split-${first}-${engine}`)
        const b = await run(whole, `whole-${first}-${engine}`)
        // 切り替え(書き出しで 3.0333 秒)の前後 0.3 秒
        const from = Math.round(2.75 * RATE)
        const to = Math.round(3.35 * RATE)
        let maxDiff = 0
        for (let i = from; i < to; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]))
        // 同じ音(符号化の誤差だけ)。前は 10〜16ms の無音・音飛びで振幅の数割の差が出た
        expect(maxDiff / 32768).toBeLessThan(0.05)
        // 5ms ごとの強さが落ちない(途切れない)
        const win = Math.round(0.005 * RATE)
        for (let i = from; i + win < to; i += win) {
          let sum = 0
          for (let k = i; k < i + win; k++) sum += (a[k] / 32768) ** 2
          expect(Math.sqrt(sum / win)).toBeGreaterThan(0.2)
        }
      }, 120_000)
})

import { execFile } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 音声分離(本編クリップの `audioDetached` + `linkedClipId` を持つ音声クリップ)をしても、
 * 繋ぎ(クロスフェード)の音は分離前と同じに混ざること(標準・区間ごとの両方)。
 * 分離した音は普通の音声クリップとして混ぜるだけだったので、繋ぎの区間で2本とも全音量のまま
 * 重なり、重なりの音量が分離前 −2.85dB に対して +2.94dB になっていた。
 */
const run = promisify(execFile)
const work = mkdtempSync(join(tmpdir(), 've-detxf-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = async (args: string[]): Promise<void> => {
  await run(ffmpegPath, ['-y', '-v', 'error', ...args])
}

async function toneVideo(id: string, color: string, freq: number): Promise<MediaAsset> {
  const path = join(work, `${id}.mp4`)
  await ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=320x180:r=30:d=6`,
    '-f',
    'lavfi',
    '-i',
    `sine=f=${freq}:d=6:sample_rate=48000`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    path
  ])
  const p = await probeMedia(path)
  return {
    id,
    filePath: path,
    fileName: id,
    duration: p.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    hasAudio: p.hasAudio,
    hasVideo: p.hasVideo
  }
}

/** 20ms ごとの音の大きさ(dB) */
async function envelopeDb(path: string): Promise<number[]> {
  const { stdout } = await run(
    ffmpegPath,
    ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 26 }
  )
  const x = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4)
  const n = 960
  const out: number[] = []
  for (let i = 0; i + n <= x.length; i += n) {
    let s = 0
    for (let j = 0; j < n; j++) s += x[i + j] * x[i + j]
    out.push(10 * Math.log10(s / n + 1e-12))
  }
  return out
}

/** 区間 [from, to) 秒の平均の大きさ(dB) */
const levelDb = (env: number[], from: number, to: number): number => {
  const w = env.slice(Math.round(from / 0.02), Math.round(to / 0.02))
  return 10 * Math.log10(w.reduce((s, d) => s + 10 ** (d / 10), 0) / w.length)
}

async function both(project: Project, name: string): Promise<[string, string]> {
  const std = join(work, `${name}-std.mp4`)
  const seg = join(work, `${name}-seg.mp4`)
  await exportProject({
    project,
    aspectRatio: '16:9',
    resolutionHeight: 180 as never,
    quality: 'standard',
    outputPath: std,
    telopLayer: null,
    onProgress: () => {}
  })
  await exportSequenceSegmented({
    project: projectV1ToV2(project, { resolution: 180 }),
    outputPath: seg,
    quality: 'standard',
    encoder: 'libx264',
    telopLayer: null
  })
  return [std, seg]
}

let red: MediaAsset
let blue: MediaAsset
beforeAll(async () => {
  red = await toneVideo('R', 'red', 300)
  blue = await toneVideo('B', 'blue', 500)
}, 60_000)

/** 4秒×3本を 1秒・0.5秒の繋ぎでつなぐ企画。`detached` なら音を音声トラックへ分離する */
function projectOf(detached: boolean): Project {
  const det = detached ? { audioDetached: true } : {}
  return {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [red, blue],
    clips: [
      { id: 'c1', assetId: 'R', inPoint: 0, outPoint: 4, speed: 1, ...det },
      {
        id: 'c2',
        assetId: 'B',
        inPoint: 0,
        outPoint: 4,
        speed: 1,
        transitionIn: { type: 'crossfade', duration: 1 },
        ...det
      },
      {
        id: 'c3',
        assetId: 'R',
        inPoint: 1,
        outPoint: 5,
        speed: 1,
        transitionIn: { type: 'crossfade', duration: 0.5 },
        ...det
      }
    ],
    audioTracks: detached
      ? [
          {
            id: 'd',
            name: 'd',
            volume: 1,
            muted: false,
            duckingEnabled: false,
            clips: [
              {
                id: 'd1',
                assetId: 'R',
                startTime: 0,
                inPoint: 0,
                outPoint: 4,
                speed: 1,
                linkedClipId: 'c1'
              },
              {
                id: 'd2',
                assetId: 'B',
                startTime: 4,
                inPoint: 0,
                outPoint: 4,
                speed: 1,
                linkedClipId: 'c2'
              },
              {
                id: 'd3',
                assetId: 'R',
                startTime: 8,
                inPoint: 1,
                outPoint: 5,
                speed: 1,
                linkedClipId: 'c3'
              }
            ]
          }
        ]
      : [],
    videoOverlayTracks: [],
    textOverlays: []
  } as unknown as Project
}

describe('音声分離した本編の音と繋ぎ(クロスフェード)', () => {
  it('分離しても、繋ぎの区間の音は分離前と同じに溶ける(標準・区間ごと)', async () => {
    const [attStd, attSeg] = await both(projectOf(false), 'attached')
    const [detStd, detSeg] = await both(projectOf(true), 'detached')
    const pairs: [string, string, string][] = [
      ['標準', attStd, detStd],
      ['区間ごと', attSeg, detSeg]
    ]
    for (const [name, att, det] of pairs) {
      const a = await envelopeDb(att)
      const d = await envelopeDb(det)
      // 1つ目の繋ぎ [3, 4) の真ん中: 分離前は 1本ぶんより約 3dB 小さい(直す前の分離は +2.94dB)
      const single = levelDb(a, 1, 2)
      expect(levelDb(a, 3.3, 3.7) - single, `${name} 分離前`).toBeLessThan(-2)
      expect(Math.abs(levelDb(d, 3.3, 3.7) - levelDb(a, 3.3, 3.7)), `${name} 繋ぎ1`).toBeLessThan(
        0.5
      )
      // 2つ目の繋ぎ [6.5, 7) も同じ
      expect(Math.abs(levelDb(d, 6.6, 6.9) - levelDb(a, 6.6, 6.9)), `${name} 繋ぎ2`).toBeLessThan(
        0.5
      )
      // 全体の形もそろう(20ms ごとに 1dB 以内。両端の窓は AAC の端の揺れがあるので除く)
      const n = Math.min(a.length, d.length) - 2
      let worst = 0
      for (let i = 2; i < n; i++) {
        if (a[i] < -50 && d[i] < -50) continue
        worst = Math.max(worst, Math.abs(a[i] - d[i]))
      }
      expect(worst, `${name} 全体の差(dB)`).toBeLessThan(1)
    }
  }, 60_000)
})

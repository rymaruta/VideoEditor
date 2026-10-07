import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 標準と区間ごとの書き出しで、音の消え方・出方がそろうこと
 * - 繋ぎ(クロスフェード)の相手に本編の音が無いとき、音のある側は繋ぎの間に消える
 * - 本編の終わりより先まで続く BGM のフェードアウトは、本編の終わりに掛かる
 */
const work = mkdtempSync(join(tmpdir(), 've-fade-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = (args: string[]): void => {
  execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])
}

async function asset(id: string, audio: 'tone' | 'none', seconds: number): Promise<MediaAsset> {
  const path = join(work, `${id}.mp4`)
  ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=320x180:r=30:d=${seconds}`,
    ...(audio === 'tone'
      ? ['-f', 'lavfi', '-i', `sine=f=440:d=${seconds}:sample_rate=48000`, '-shortest']
      : []),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    ...(audio === 'tone' ? ['-c:a', 'aac', '-b:a', '256k'] : ['-an']),
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

/** [from, to) 秒の音の実効値 */
function rms(path: string, from: number, to: number): number {
  const raw = execFileSync(
    ffmpegPath,
    ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 28 }
  )
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  let s = 0
  let n = 0
  for (let i = Math.round(from * 48000); i < Math.min(x.length, Math.round(to * 48000)); i++) {
    s += x[i] * x[i]
    n++
  }
  return n ? Math.sqrt(s / n) : 0
}

async function both(project: Project, name: string): Promise<[string, string]> {
  const std = join(work, `${name}-std.mp4`)
  const seg = join(work, `${name}-seg.mp4`)
  await exportProject({
    project,
    aspectRatio: '16:9',
    resolutionHeight: 720,
    quality: 'standard',
    outputPath: std,
    telopLayer: null,
    onProgress: () => {}
  })
  await exportSequenceSegmented({
    project: projectV1ToV2(project, { resolution: 720 }),
    outputPath: seg,
    quality: 'standard',
    encoder: 'libx264',
    telopLayer: null
  })
  return [std, seg]
}

const base = (assets: MediaAsset[]): Project =>
  ({
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets,
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: []
  }) as unknown as Project

describe('標準と区間ごとの書き出しの、音の消え方', () => {
  it('繋ぎの相手に音が無いとき、音のある側は繋ぎの間に消えていく(どちらの書き出しでも)', async () => {
    const a = await asset('a', 'tone', 6)
    const b = await asset('b', 'none', 6)
    const project = {
      ...base([a, b]),
      clips: [
        { id: 'c1', assetId: 'a', inPoint: 0, outPoint: 4, speed: 1 },
        {
          id: 'c2',
          assetId: 'b',
          inPoint: 0,
          outPoint: 4,
          speed: 1,
          transitionIn: { type: 'crossfade', duration: 1 }
        }
      ]
    } as unknown as Project
    for (const out of await both(project, 'xfade')) {
      const early = rms(out, 1, 2)
      // 繋ぎは 3〜4 秒。終わりに向かって小さくなる
      expect(rms(out, 3.0, 3.25), out).toBeGreaterThan(rms(out, 3.75, 4.0) * 2)
      expect(rms(out, 3.75, 4.0), out).toBeLessThan(early * 0.5)
    }
  }, 180_000)

  it('前の短いクリップより長い繋ぎでも、区間ごとの書き出しの音量は標準と同じ', async () => {
    const t = await asset('t', 'tone', 30)
    // 4 秒・0.3 秒(繋ぎより短い)・6 秒(1 秒のクロスフェード)。同じ音を続けるので、どこも同じ大きさのはず
    const project = {
      ...base([t]),
      clips: [
        { id: 'c0', assetId: 't', inPoint: 0, outPoint: 4, speed: 1 },
        { id: 'c1', assetId: 't', inPoint: 10, outPoint: 10.3, speed: 1 },
        {
          id: 'c2',
          assetId: 't',
          inPoint: 20,
          outPoint: 26,
          speed: 1,
          transitionIn: { type: 'crossfade', duration: 1 }
        }
      ]
    } as unknown as Project
    const [std, seg] = await both(project, 'longxfade')
    for (const [a, b] of [
      [1, 2],
      [3.4, 3.9],
      [4.5, 5],
      [7, 8],
      [8.8, 9.2]
    ])
      expect(rms(seg, a, b), `${a}-${b}`).toBeCloseTo(rms(std, a, b), 1)
  }, 180_000)

  it('前の短いクリップに音が無くても、長い繋ぎの音量は標準と同じ', async () => {
    const t = await asset('t2', 'tone', 30)
    const mute = await asset('mute', 'none', 5)
    const project = {
      ...base([t, mute]),
      clips: [
        { id: 'c0', assetId: 't2', inPoint: 0, outPoint: 4, speed: 1 },
        { id: 'c1', assetId: 'mute', inPoint: 1, outPoint: 1.3, speed: 1 },
        {
          id: 'c2',
          assetId: 't2',
          inPoint: 20,
          outPoint: 26,
          speed: 1,
          transitionIn: { type: 'crossfade', duration: 1 }
        }
      ]
    } as unknown as Project
    const [std, seg] = await both(project, 'silentmid')
    for (const [a, b] of [
      [1, 2],
      [3.5, 3.7],
      [3.7, 3.9],
      [3.9, 4.1],
      [6, 7]
    ])
      expect(rms(seg, a, b), `${a}-${b}`).toBeCloseTo(rms(std, a, b), 2)
  }, 180_000)

  it('本編の終わりより先まで続く BGM のフェードアウトは、本編の終わりに掛かる', async () => {
    const v = await asset('v', 'none', 6)
    const bgm = await asset('bgm', 'tone', 12)
    const project = {
      ...base([v, bgm]),
      clips: [{ id: 'c', assetId: 'v', inPoint: 0, outPoint: 5, speed: 1 }],
      audioTracks: [
        {
          id: 't',
          name: 'BGM',
          muted: false,
          volume: 1,
          duckingEnabled: false,
          clips: [{ id: 'b', assetId: 'bgm', startTime: 0, inPoint: 0, outPoint: 10, fadeOut: 2 }]
        }
      ]
    } as unknown as Project
    for (const out of await both(project, 'bgm')) {
      expect(rms(out, 4.6, 4.95), out).toBeLessThan(rms(out, 1, 2) * 0.4)
    }
  }, 180_000)
})

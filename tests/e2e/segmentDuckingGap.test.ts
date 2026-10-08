import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 区間ごとの書き出しで、ダッキングするトラック(BGM)が鳴らない区間に、音が映像より短い本編の
 * クリップがあっても書き出せる(声の枝を捨てるグラフで ffmpeg が落ちていた)
 */
const work = mkdtempSync(join(tmpdir(), 've-duckgap-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
const ff = (args: string[]): void => void execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])

async function assetOf(id: string, path: string): Promise<MediaAsset> {
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

describe('区間ごとの書き出しとダッキング', () => {
  it('BGM の無い区間に、音が映像より短いクリップがあっても書き出せる', async () => {
    const v = join(work, 'v.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=4',
      '-f',
      'lavfi',
      '-i',
      'sine=f=300:d=3.8:sample_rate=48000',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      v
    ])
    const m = join(work, 'm.wav')
    ff(['-f', 'lavfi', '-i', 'sine=f=500:d=2:sample_rate=48000', m])
    const va = await assetOf('V', v)
    const ma = await assetOf('M', m)
    const project = {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [va, ma],
      clips: [
        { id: 'c1', assetId: 'V', inPoint: 0, outPoint: 4, speed: 1 },
        { id: 'c2', assetId: 'V', inPoint: 0, outPoint: va.duration, speed: 1 }
      ],
      audioTracks: [
        {
          id: 'bgm',
          name: 'BGM',
          volume: 1,
          muted: false,
          duckingEnabled: true,
          clips: [{ id: 'b', assetId: 'M', startTime: 0, inPoint: 0, outPoint: 2 }]
        }
      ],
      videoOverlayTracks: [],
      textOverlays: []
    } as unknown as Project
    const out = join(work, 'seg.mp4')
    await exportSequenceSegmented({
      project: projectV1ToV2(project, { resolution: 480 }),
      outputPath: out,
      quality: 'small',
      encoder: 'libx264',
      telopLayer: null,
      segmentOptions: { targetFrames: 120, minFrames: 60, maxFrames: 150 }
    })
    expect((await probeMedia(out)).duration).toBeGreaterThan(7.5)
  }, 120_000)
})

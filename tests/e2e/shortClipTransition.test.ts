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
 * 繋ぎが手前のクリップより長いとき、手前の短いクリップが書き出しから消えないこと
 * (区間ごとの書き出しは始まりの順に並べていて、繋ぎのクリップが短いクリップより先に来て捨てていた)
 */
const work = mkdtempSync(join(tmpdir(), 've-shortxf-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

async function solid(id: string, color: string): Promise<MediaAsset> {
  const path = join(work, `${id}.mp4`)
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=320x180:r=30:d=6`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
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

/** frame 番目の画の真ん中の色 [R, G, B] */
function centerRgb(path: string, frame: number): number[] {
  const raw = execFileSync(
    ffmpegPath,
    [
      '-v',
      'error',
      '-i',
      path,
      '-vf',
      `select=eq(n\\,${frame}),crop=2:2:iw/2:ih/2,scale=1:1`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ],
    { maxBuffer: 1 << 20 }
  )
  return [raw[0], raw[1], raw[2]]
}

describe('手前より長い繋ぎ', () => {
  it('0.5 秒のクリップの後ろに 1 秒の繋ぎがあっても、どちらの書き出しにも短いクリップが映る', async () => {
    const red = await solid('red', 'red')
    const green = await solid('green', 'lime')
    const blue = await solid('blue', 'blue')
    const project = {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [red, green, blue],
      clips: [
        { id: 'A', assetId: 'red', inPoint: 0, outPoint: 3, speed: 1 },
        { id: 'B', assetId: 'green', inPoint: 0, outPoint: 0.5, speed: 1 },
        {
          id: 'C',
          assetId: 'blue',
          inPoint: 0,
          outPoint: 3,
          speed: 1,
          transitionIn: { type: 'crossfade', duration: 1 }
        }
      ],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: []
    } as unknown as Project
    const std = join(work, 'std.mp4')
    const seg = join(work, 'seg.mp4')
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
    // 3.17 秒(95 フレーム目)は B(緑)から C(青)へ移る途中。緑が混ざっていること
    const a = centerRgb(std, 95)
    const b = centerRgb(seg, 95)
    expect(a[1], `std ${a}`).toBeGreaterThan(60)
    expect(b[1], `seg ${b}`).toBeGreaterThan(60)
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i]), `${a} vs ${b}`).toBeLessThan(24)
  }, 180_000)
})

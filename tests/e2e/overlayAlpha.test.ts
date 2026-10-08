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
 * 透過付きの WebM(VP9)を全面に重ねると、透過の所に下の本編が見える(どちらの書き出しでも)。
 * ffmpeg 標準の vp9 デコーダは透過を捨てるので、透過の所が黒になっていた(プレビューでは透けていた)
 */
const work = mkdtempSync(join(tmpdir(), 've-alpha-'))
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

function rgbAt(path: string, sec: number, x: number, y: number): number[] {
  const raw = execFileSync(ffmpegPath, [
    '-v',
    'error',
    '-ss',
    String(sec),
    '-i',
    path,
    '-vf',
    `crop=2:2:${x}:${y},scale=1:1`,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-'
  ])
  return [raw[0], raw[1], raw[2]]
}

describe('透過付きの WebM の重ね', () => {
  it('透過の所に下の本編が見える', async () => {
    const red = join(work, 'red.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=1280x720:r=30:d=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      red
    ])
    const cg = join(work, 'cg.webm')
    ff([
      '-f',
      'lavfi',
      '-i',
      "color=c=white:s=1280x720:r=30:d=3,format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(between(X,540,740)*between(Y,260,460),255,0)'",
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuva420p',
      '-auto-alt-ref',
      '0',
      cg
    ])
    const main = await assetOf('red', red)
    const over = await assetOf('cg', cg)
    const project = {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [main, over],
      clips: [{ id: 'c1', assetId: 'red', inPoint: 0, outPoint: 3, speed: 1 }],
      audioTracks: [],
      videoOverlayTracks: [
        {
          id: 'cgT',
          name: 'CG',
          hidden: false,
          position: 'full',
          scale: 1,
          clips: [{ id: 'o1', assetId: 'cg', startTime: 0, inPoint: 0, outPoint: 3 }]
        }
      ],
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
    for (const out of [std, seg]) {
      const edge = rgbAt(out, 1, 100, 100)
      expect(edge[0], `${out} ${edge}`).toBeGreaterThan(200)
      expect(edge[1], `${out} ${edge}`).toBeLessThan(50)
      const mid = rgbAt(out, 1, 640, 360)
      expect(mid[1], `${out} ${mid}`).toBeGreaterThan(200)
    }
  }, 180_000)
})

import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * カメラの色合わせは、10bit の素材(ソニー・GH5・iPhone の HEVC など)でも 8bit と同じ明るさで書き出す。
 * 8bit の値(0〜255)と決めた式だと、10bit の素材は 25% より明るい所がすべて潰れ、ほぼ黒になっていた
 */
const work = mkdtempSync(join(tmpdir(), 've-color10-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = (args: string[]): Buffer => execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])

/** 書き出した動画の 1 秒目の真ん中の画素(RGB) */
function centerPixel(path: string): number[] {
  const raw = ff([
    '-ss',
    '1',
    '-i',
    path,
    '-frames:v',
    '1',
    '-vf',
    'crop=2:2:iw/2:ih/2,format=rgb24',
    '-f',
    'rawvideo',
    '-'
  ])
  return [raw[0], raw[1], raw[2]]
}

describe.skipIf(!existsSync(ffmpegPath))('色合わせと 10bit の素材', () => {
  it('8bit・10bit のどちらの素材でも、標準・区間分割のどちらの書き出しでも同じ明るさ', async () => {
    const results: number[] = []
    for (const [name, codec, pix] of [
      ['g8', 'libx264', 'yuv420p'],
      ['g10', 'libx265', 'yuv420p10le']
    ]) {
      const src = join(work, `${name}.mp4`)
      ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=0x808080:s=640x360:r=30:d=2',
        '-c:v',
        codec,
        ...(codec === 'libx265' ? ['-x265-params', 'log-level=error'] : []),
        '-pix_fmt',
        pix,
        src
      ])
      const p = await probeMedia(src)
      const asset: MediaAsset = {
        id: name,
        filePath: src,
        fileName: name,
        duration: p.duration,
        width: p.width,
        height: p.height,
        fps: p.fps,
        hasAudio: false,
        hasVideo: true,
        colorMatch: { gain: [1, 1, 1], offset: [0.05, 0.05, 0.05] }
      }
      const project = {
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [asset],
        clips: [{ id: 'c', assetId: name, inPoint: 0, outPoint: 2, speed: 1 }],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: []
      } as unknown as Project
      const std = join(work, `${name}-std.mp4`)
      await exportProject({
        project,
        aspectRatio: '16:9',
        resolutionHeight: 480,
        quality: 'standard',
        outputPath: std,
        telopLayer: null,
        onProgress: () => {}
      })
      const seg = join(work, `${name}-seg.mp4`)
      await exportSequenceSegmented({
        project: projectV1ToV2(project, { resolution: 480 }),
        outputPath: seg,
        quality: 'standard',
        encoder: 'libx264',
        telopLayer: null
      })
      for (const out of [std, seg]) results.push(centerPixel(out)[1])
    }
    // 0x80 = 128 に 0.05 × 255 ≈ 13 を足した明るさ(圧縮の誤差を見込む)
    for (const g of results) expect(g, results.join(',')).toBeGreaterThan(130)
    for (const g of results) expect(g, results.join(',')).toBeLessThan(150)
  }, 180_000)
})

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
 * 音声の無い企画で音量の正規化を ON にしても書き出せる(標準は「メディアファイルを処理できませんでした」、
 * 区間ごとは `aac … Invalid argument` で失敗していた)。音声が無ければ正規化を飛ばす
 */
const work = mkdtempSync(join(tmpdir(), 've-loud-noaudio-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe.skipIf(!existsSync(ffmpegPath))('音声の無い企画の音量の正規化', () => {
  it('標準・区間ごとの書き出しとも、正規化 ON で失敗しない', async () => {
    const src = join(work, 'silent.mp4')
    execFileSync(ffmpegPath, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=10:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      src
    ])
    const p = await probeMedia(src)
    const asset: MediaAsset = {
      id: 'v',
      filePath: src,
      fileName: 'silent.mp4',
      duration: p.duration,
      width: p.width,
      height: p.height,
      fps: p.fps,
      hasAudio: false,
      hasVideo: true
    }
    const project = {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [asset],
      clips: [{ id: 'c', assetId: 'v', inPoint: 0, outPoint: 2, speed: 1 }],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: []
    } as unknown as Project
    const std = join(work, 'std.mp4')
    await exportProject({
      project,
      aspectRatio: '16:9',
      resolutionHeight: 180 as never,
      quality: 'standard',
      outputPath: std,
      telopLayer: null,
      loudnessNormalization: true,
      loudnessTarget: 'web',
      onProgress: () => {}
    })
    const seg = join(work, 'seg.mp4')
    await exportSequenceSegmented({
      project: projectV1ToV2(project, { resolution: 180 }),
      outputPath: seg,
      quality: 'standard',
      encoder: 'libx264',
      telopLayer: null,
      loudnessNormalization: true,
      loudnessTarget: 'web'
    })
    for (const out of [std, seg]) {
      const r = await probeMedia(out)
      expect(r.duration, out).toBeGreaterThan(1.8)
      expect(r.duration, out).toBeLessThan(2.3)
      // 正規化しないときと同じく、無音の音声トラックを付ける
      expect(r.hasAudio, out).toBe(true)
    }
  }, 120_000)
})

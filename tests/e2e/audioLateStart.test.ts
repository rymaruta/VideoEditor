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
 * 音が映像より遅れて始まる素材(録画機・書き出し直した物)も、書き出しで音が早く鳴らない。
 * 頭の隙間を消して 0 へ寄せると、口の動きより音が先に鳴っていた(プレビューは正しい)
 */
const work = mkdtempSync(join(tmpdir(), 've-latestart-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** 書き出した音で、最初に大きく鳴る時刻(秒) */
function beepAt(path: string): number {
  const raw = execFileSync(
    ffmpegPath,
    ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 26 }
  )
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  const i = x.findIndex((v) => Math.abs(v) > 0.3)
  return i / 48000
}

describe.skipIf(!existsSync(ffmpegPath))('音が遅れて始まる素材', () => {
  it('標準・区間分割のどちらの書き出しでも、鳴る時刻は素材と同じ(本編・分離した音・入点の後ろ)', async () => {
    const src = join(work, 'late.mp4')
    execFileSync(ffmpegPath, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=6',
      '-itsoffset',
      '0.5',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(between(t,2,2.1),0.8*sin(2*PI*1000*t),0)':d=5.5:s=48000",
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      src
    ])
    const p = await probeMedia(src)
    const asset: MediaAsset = {
      id: 'a',
      filePath: src,
      fileName: 'late.mp4',
      duration: p.duration,
      width: p.width,
      height: p.height,
      fps: p.fps,
      hasAudio: true,
      hasVideo: true
    }
    for (const [name, inPoint, expected] of [
      ['in0', 0, 2.5],
      ['in1', 1, 1.5]
    ] as const) {
      const project = {
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [asset],
        clips: [{ id: 'c', assetId: 'a', inPoint, outPoint: 5, speed: 1 }],
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
      for (const out of [std, seg]) expect(beepAt(out), `${name} ${out}`).toBeCloseTo(expected, 1)
    }
  }, 180_000)
})

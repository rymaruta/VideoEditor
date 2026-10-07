import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 音を鳴らさないワイプ(ゲーム実況の顔カメラ)の音が、書き出しに混ざらないこと。
 * 本編は無音の絵、ワイプは 1kHz の音の入った絵。ワイプの音を消せば、書き出しは無音になる
 */

const work = mkdtempSync(join(tmpdir(), 've-pipmute-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = (args: string[]): void => {
  execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])
}

async function asset(id: string, withTone: boolean): Promise<MediaAsset> {
  const path = join(work, `${id}.mp4`)
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=30:d=4',
    '-f',
    'lavfi',
    '-i',
    withTone ? 'sine=f=1000:d=4:sample_rate=48000' : 'anullsrc=r=48000:cl=mono:d=4',
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
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

/** 書き出した音の大きさの最大(dB)。ffmpeg の volumedetect は結果を stderr に出す */
function peakDbOf(path: string): number {
  const r = spawnSync(ffmpegPath, ['-i', path, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], {
    encoding: 'utf8'
  })
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)
  return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN
}

describe('音を鳴らさないワイプ(顔カメラ)', () => {
  it('標準・区間分割のどちらの書き出しでも、ワイプの音が混ざらない(鳴らすワイプは鳴る)', async () => {
    const main = await asset('main', false)
    const face = await asset('face', true)
    const make = (audioMuted: boolean): Project => ({
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [main, face],
      clips: [{ id: 'c', assetId: 'main', inPoint: 0, outPoint: 4, speed: 1 }],
      audioTracks: [],
      videoOverlayTracks: [
        {
          id: 'face',
          name: '顔',
          hidden: false,
          ...(audioMuted ? { audioMuted: true } : {}),
          position: 'bottom-right',
          scale: 0.26,
          clips: [{ id: 'fc', assetId: 'face', startTime: 0, inPoint: 0, outPoint: 4 }]
        }
      ],
      textOverlays: []
    })
    for (const audioMuted of [true, false]) {
      const std = join(work, `std-${audioMuted}.mp4`)
      await exportProject({
        project: make(audioMuted),
        aspectRatio: '16:9',
        resolutionHeight: 720,
        quality: 'standard',
        outputPath: std,
        telopLayer: null,
        onProgress: () => {}
      })
      const seg = join(work, `seg-${audioMuted}.mp4`)
      await exportSequenceSegmented({
        project: projectV1ToV2(make(audioMuted), { resolution: 720 }),
        outputPath: seg,
        quality: 'standard',
        encoder: 'libx264',
        telopLayer: null
      })
      for (const out of [std, seg]) {
        const peak = peakDbOf(out)
        if (audioMuted) expect(peak).toBeLessThan(-60)
        else expect(peak).toBeGreaterThan(-20)
      }
    }
  }, 120_000)
})

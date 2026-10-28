import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { projectForOutput } from '@shared/trackVisibility'
import type { MediaAsset, Project } from '@shared/types'

/**
 * V1(本編)の「目」を閉じると、書き出しでも本編の絵は黒になり(音は鳴る)、ワイプは上に重なる。
 * 標準の書き出しと区間ごとの書き出しの両方で確かめる(Premiere と同じく、隠したトラックは書き出さない)
 */

const work = mkdtempSync(join(tmpdir(), 've-trackvis-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = (args: string[]): void => {
  execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])
}

/** 明るい一色の絵 + 1kHz の音(4 秒) */
async function asset(id: string, color: string): Promise<MediaAsset> {
  const path = join(work, `${id}.mp4`)
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=320x180:r=30:d=4`,
    '-f',
    'lavfi',
    '-i',
    'sine=f=1000:d=4:sample_rate=48000',
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

/** 2 秒の所の 1 枚の、左上(本編だけの所)と右下(ワイプの所)の明るさ(0〜255) */
function lumaAt(path: string): { corner: number; pip: number } {
  const r = spawnSync(
    ffmpegPath,
    [
      '-v',
      'error',
      '-ss',
      '2',
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      'scale=32:18,format=gray',
      '-f',
      'rawvideo',
      '-'
    ],
    { maxBuffer: 1 << 20 }
  )
  const px = r.stdout as Buffer
  return { corner: px[0], pip: px[14 * 32 + 26] }
}

function peakDbOf(path: string): number {
  const r = spawnSync(ffmpegPath, ['-i', path, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], {
    encoding: 'utf8'
  })
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)
  return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN
}

describe('V1 の「目」を閉じた書き出し', () => {
  it('標準・区間ごとのどちらでも、本編の絵は黒・本編の音は鳴る・ワイプは重なる', async () => {
    const main = await asset('main', 'white')
    const face = await asset('face', 'white')
    const make = (mainVideoHidden: boolean): Project => ({
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
          audioMuted: true,
          position: 'bottom-right',
          scale: 0.3,
          clips: [{ id: 'fc', assetId: 'face', startTime: 0, inPoint: 0, outPoint: 4 }]
        }
      ],
      textOverlays: [],
      ...(mainVideoHidden ? { mainVideoHidden: true } : {})
    })
    for (const hidden of [true, false]) {
      const std = join(work, `std-${hidden}.mp4`)
      await exportProject({
        project: make(hidden),
        aspectRatio: '16:9',
        resolutionHeight: 720,
        quality: 'standard',
        outputPath: std,
        telopLayer: null,
        onProgress: () => {}
      })
      const seg = join(work, `seg-${hidden}.mp4`)
      await exportSequenceSegmented({
        project: projectV1ToV2(make(hidden), { resolution: 720 }),
        outputPath: seg,
        quality: 'standard',
        encoder: 'libx264',
        telopLayer: null
      })
      for (const out of [std, seg]) {
        const { corner, pip } = lumaAt(out)
        if (hidden) expect(corner).toBeLessThan(30)
        else expect(corner).toBeGreaterThan(200)
        // ワイプ(白)はどちらでも重なる
        expect(pip).toBeGreaterThan(200)
        // 本編の音は隠しても鳴る
        expect(peakDbOf(out)).toBeGreaterThan(-20)
      }
    }
  }, 180_000)
})

describe('T1 の「目」を閉じた書き出し', () => {
  it('書き出しへ渡す企画からテロップを外す(開いていればそのまま)', () => {
    const base = {
      textOverlays: [{ id: 't' }] as unknown as Project['textOverlays']
    }
    expect(projectForOutput({ ...base, telopTrackHidden: true }).textOverlays).toEqual([])
    expect(projectForOutput(base).textOverlays).toHaveLength(1)
    expect(projectForOutput({ ...base, telopTrackHidden: false }).textOverlays).toHaveLength(1)
  })
})

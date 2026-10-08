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
 * 5.1 の素材の音を、プレビュー(Chromium の Web Audio の畳み方)と同じ大きさで書き出す。
 * 正規化した畳み方だと、書き出しだけ 7.7 dB 小さかった
 */
const work = mkdtempSync(join(tmpdir(), 've-surround-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** 左の音の大きさ(RMS・dB) */
function leftDb(path: string): number {
  return channelDb(path, 0)
}

/** 指定のチャンネルの音の大きさ(RMS・dB) */
function channelDb(path: string, ch: number): number {
  const raw = execFileSync(
    ffmpegPath,
    [
      '-v',
      'error',
      '-i',
      path,
      '-vn',
      '-af',
      `pan=mono|c0=c${ch}`,
      '-ar',
      '48000',
      '-f',
      'f32le',
      '-'
    ],
    { maxBuffer: 1 << 26 }
  )
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  let s = 0
  const from = 48000
  const to = Math.min(x.length, 48000 * 3)
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return 10 * Math.log10(s / (to - from))
}

async function clipOf(audio: string, name: string): Promise<MediaAsset> {
  const path = join(work, `${name}.mp4`)
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=30:d=4',
    '-f',
    'lavfi',
    '-i',
    audio,
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '384k',
    path
  ])
  const p = await probeMedia(path)
  return {
    id: name,
    filePath: path,
    fileName: name,
    duration: p.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    hasAudio: true,
    hasVideo: true
  }
}

describe.skipIf(!existsSync(ffmpegPath))('5.1 の素材の書き出し', () => {
  it('前の左だけに音がある 5.1 は、同じ音のステレオと同じ大きさ(標準・区間分割とも)', async () => {
    const tone = 'sine=f=1000:d=4:sample_rate=48000'
    const stereo = await clipOf(`${tone},pan=stereo|c0=0.1*c0|c1=0*c0`, 'st')
    const surround = await clipOf(
      `${tone},pan=5.1|c0=0.1*c0|c1=0*c0|c2=0*c0|c3=0*c0|c4=0*c0|c5=0*c0`,
      'sur'
    )
    const levels: number[] = []
    for (const a of [stereo, surround]) {
      const project = {
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [a],
        clips: [{ id: 'c', assetId: a.id, inPoint: 0, outPoint: 4, speed: 1 }],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: []
      } as unknown as Project
      const std = join(work, `${a.id}-std.mp4`)
      await exportProject({
        project,
        aspectRatio: '16:9',
        resolutionHeight: 480,
        quality: 'standard',
        outputPath: std,
        telopLayer: null,
        onProgress: () => {}
      })
      const seg = join(work, `${a.id}-seg.mp4`)
      await exportSequenceSegmented({
        project: projectV1ToV2(project, { resolution: 480 }),
        outputPath: seg,
        quality: 'standard',
        encoder: 'libx264',
        telopLayer: null
      })
      levels.push(leftDb(std), leftDb(seg))
    }
    const [stStd, stSeg, surStd, surSeg] = levels
    expect(Math.abs(surStd - stStd), levels.join(',')).toBeLessThan(0.5)
    expect(Math.abs(surSeg - stSeg), levels.join(',')).toBeLessThan(0.5)
  }, 180_000)
  it('センターにだけ音がある 4.0 の素材は、左右に同じ大きさで出す(片方だけにしない)', async () => {
    const a = await clipOf(
      'sine=f=1000:d=4:sample_rate=48000,pan=4.0|c0=0*c0|c1=0*c0|c2=0.1*c0|c3=0*c0',
      'four'
    )
    const project = {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [a],
      clips: [{ id: 'c', assetId: a.id, inPoint: 0, outPoint: 4, speed: 1 }],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: []
    } as unknown as Project
    const std = join(work, 'four-std.mp4')
    await exportProject({
      project,
      aspectRatio: '16:9',
      resolutionHeight: 480,
      quality: 'standard',
      outputPath: std,
      telopLayer: null,
      onProgress: () => {}
    })
    const seg = join(work, 'four-seg.mp4')
    await exportSequenceSegmented({
      project: projectV1ToV2(project, { resolution: 480 }),
      outputPath: seg,
      quality: 'standard',
      encoder: 'libx264',
      telopLayer: null
    })
    for (const out of [std, seg]) {
      const l = channelDb(out, 0)
      const r = channelDb(out, 1)
      expect(Number.isFinite(r), out).toBe(true)
      expect(Math.abs(l - r), `${out} ${l} ${r}`).toBeLessThan(0.5)
    }
  }, 180_000)
  it('quad の後ろ左の音は、プレビュー(Chromium の畳み方)と同じく左に半分の大きさで出す', async () => {
    const tone = 'sine=f=1000:d=4:sample_rate=48000'
    const ref = await clipOf(`${tone},pan=stereo|c0=0.2*c0|c1=0*c0`, 'qref')
    const quad = await clipOf(`${tone},pan=quad|c0=0*c0|c1=0*c0|c2=0.2*c0|c3=0*c0`, 'quad')
    const levels: number[] = []
    for (const a of [ref, quad]) {
      const project = {
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [a],
        clips: [{ id: 'c', assetId: a.id, inPoint: 0, outPoint: 4, speed: 1 }],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: []
      } as unknown as Project
      const std = join(work, `${a.id}-std.mp4`)
      await exportProject({
        project,
        aspectRatio: '16:9',
        resolutionHeight: 480,
        quality: 'standard',
        outputPath: std,
        telopLayer: null,
        onProgress: () => {}
      })
      levels.push(channelDb(std, 0))
    }
    // 0.5 倍 = -6.02 dB
    expect(Math.abs(levels[1] - (levels[0] - 6.02)), levels.join(',')).toBeLessThan(0.5)
  }, 180_000)
})

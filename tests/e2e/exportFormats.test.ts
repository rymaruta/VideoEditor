import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ffmpegPath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2, timelineRangeToExportFrames } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 書き出しの形式(ProRes 422 の .mov・音声だけの WAV)と、範囲だけの書き出し(第3段の書き出しの画面)。
 * 本物の ffmpeg で書き出し、入れ物・コーデック・長さを確かめる
 */
const work = mkdtempSync(join(tmpdir(), 've-formats-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const DUR = 8
const SEG = { targetFrames: 75, minFrames: 60, maxFrames: 90 }
let project: Project

beforeAll(async () => {
  const src = join(work, 'talk.mp4')
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=160x90:r=30:d=${DUR}`,
    '-f',
    'lavfi',
    '-i',
    `sine=f=440:d=${DUR}:sample_rate=48000`,
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    src
  ])
  const p = await probeMedia(src)
  const asset: MediaAsset = {
    id: 'A',
    filePath: src,
    fileName: 'talk',
    duration: p.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    hasAudio: true,
    hasVideo: true
  }
  project = {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [asset],
    clips: [{ id: 'c', assetId: 'A', inPoint: 0, outPoint: DUR, speed: 1 }],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: []
  } as unknown as Project
}, 60_000)

/** ffmpeg が読み取った入れ物とストリームの説明(stderr) */
function describe_(path: string): string {
  return spawnSync(ffmpegPath, ['-hide_banner', '-i', path], { encoding: 'utf8' }).stderr
}

const v2 = (): ReturnType<typeof projectV1ToV2> =>
  projectV1ToV2(project, { resolution: 360 as never })

describe.skipIf(!existsSync(ffmpegPath))('書き出しの形式と範囲', () => {
  it('ProRes 422: QuickTime の入れ物・prores(10bit 4:2:2)・PCM 24bit で、長さは尺どおり', async () => {
    const out = join(work, 'master.mov')
    await exportSequenceSegmented({
      project: v2(),
      outputPath: out,
      quality: 'standard',
      telopLayer: null,
      segmentOptions: SEG,
      format: 'prores'
    })
    const info = describe_(out)
    expect(info).toMatch(/mov,mp4,m4a,3gp,3g2,mj2/)
    expect(info).toMatch(/Video: prores \(HQ\)|Video: prores \(Standard\)|Video: prores/)
    expect(info).toMatch(/yuv422p10le/)
    expect(info).toMatch(/Audio: pcm_s24le/)
    const m = await probeMedia(out)
    expect(Math.abs(m.duration - DUR)).toBeLessThan(0.05)
  }, 180_000)

  it('音声のみ: WAV(PCM 24bit・48kHz・ステレオ)で映像を持たず、長さは尺どおり', async () => {
    const out = join(work, 'voice.wav')
    await exportSequenceSegmented({
      project: v2(),
      outputPath: out,
      quality: 'standard',
      telopLayer: null,
      segmentOptions: SEG,
      format: 'wav',
      loudnessNormalization: true
    })
    const info = describe_(out)
    expect(info).toMatch(/Input #0, wav/)
    expect(info).toMatch(/Audio: pcm_s24le.*48000 Hz, stereo/)
    expect(info).not.toMatch(/Video:/)
    const m = await probeMedia(out)
    expect(m.hasVideo).toBe(false)
    expect(Math.abs(m.duration - DUR)).toBeLessThan(0.05)
  }, 180_000)

  it('範囲だけ: タイムラインの 2〜6.5 秒を書き出すと、長さは 4.5 秒(区間の境をまたいでも)', async () => {
    const out = join(work, 'range.mp4')
    const r = timelineRangeToExportFrames(project, 2, 6.5)
    expect(r).toEqual({ startFrame: 60, endFrame: 195, startSec: 2 })
    await exportSequenceSegmented({
      project: v2(),
      outputPath: out,
      quality: 'standard',
      encoder: 'libx264',
      telopLayer: null,
      segmentOptions: SEG,
      range: { startFrame: r!.startFrame, endFrame: r!.endFrame }
    })
    const decode = spawnSync(ffmpegPath, ['-v', 'error', '-i', out, '-f', 'null', '-'], {
      encoding: 'utf8'
    })
    expect(decode.stderr).toBe('')
    const m = await probeMedia(out)
    expect(Math.abs(m.duration - 4.5)).toBeLessThan(0.05)
  }, 180_000)

  it('【監査 2026-10】範囲の始まりが繋ぎの途中なら、繋ぎの手前へ広げ、その始まりを返す(点検の時刻はこれで合わせる)', async () => {
    // 0〜4 秒と、4 秒から 1 秒のクロスフェードで入る 2 本目(書き出しでは 3〜4 秒が繋ぎ)
    const p = {
      ...project,
      clips: [
        { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1 },
        {
          id: 'c2',
          assetId: 'A',
          inPoint: 4,
          outPoint: 8,
          speed: 1,
          transitionIn: { type: 'crossfade', duration: 1 }
        }
      ]
    } as unknown as Project
    const r = timelineRangeToExportFrames(p, 4.2, 6.5)
    // タイムライン 4.2 秒は、書き出しでは 3.2 秒(96 フレーム)= 繋ぎの途中
    expect(r).toMatchObject({ startFrame: 96, endFrame: 165 })
    const out = join(work, 'range-trans.mp4')
    const res = await exportSequenceSegmented({
      project: projectV1ToV2(p, { resolution: 360 as never }),
      outputPath: out,
      quality: 'standard',
      encoder: 'libx264',
      telopLayer: null,
      segmentOptions: SEG,
      range: { startFrame: r!.startFrame, endFrame: r!.endFrame }
    })
    // 繋ぎ(90〜120 フレーム)を割らないよう、始まりは 89 へ広がる。ファイルの 0 秒はここ
    expect(res.startFrame).toBe(89)
    expect(res.frames).toBe(165 - 89)
    const m = await probeMedia(out)
    expect(Math.abs(m.duration - (165 - 89) / 30)).toBeLessThan(0.05)
  }, 180_000)
})

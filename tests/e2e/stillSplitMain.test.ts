import { execFile } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, ffprobePath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { STILL_DURATION_SEC } from '@shared/mediaExtensions'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 入点が 0 より後ろの静止画(分割した静止画の後ろ半分・頭を詰めた静止画)を本編に置いても、
 * 標準の書き出しで絵が消えないこと。
 * 画像の入力には 0 秒の1枚しか無いので、`-ss 入点` で開くとその1枚を飛び越えて枝が空になり、
 * 映像だけ短くなって後ろの絵が前へずれていた(繋ぎ入りでは映像が途中で止まった)。
 */
const run = promisify(execFile)
const work = mkdtempSync(join(tmpdir(), 've-stillsplit-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = async (args: string[]): Promise<void> => {
  await run(ffmpegPath, ['-y', '-v', 'error', ...args])
}

async function assetOf(
  id: string,
  path: string,
  extra: Partial<MediaAsset> = {}
): Promise<MediaAsset> {
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
    hasVideo: p.hasVideo,
    ...extra
  }
}

/** 映像の枚数と、音声の長さ */
async function streams(path: string): Promise<{ frames: number; audio: number }> {
  const { stdout } = await run(ffprobePath, [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'stream=codec_type,nb_read_frames,duration',
    '-of',
    'json',
    path
  ])
  const j = JSON.parse(stdout) as { streams: Record<string, string>[] }
  const v = j.streams.find((s) => s.codec_type === 'video')
  const a = j.streams.find((s) => s.codec_type === 'audio')
  return { frames: Number(v?.nb_read_frames ?? 0), audio: Number(a?.duration ?? 0) }
}

/** その時刻の画面全体の平均色(RGB) */
async function rgbAt(path: string, sec: number): Promise<number[]> {
  const { stdout } = await run(
    ffmpegPath,
    [
      '-v',
      'error',
      '-ss',
      String(sec),
      '-i',
      path,
      '-vf',
      'scale=1:1:flags=area',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ],
    { encoding: 'buffer' }
  )
  return [stdout[0], stdout[1], stdout[2]]
}

async function both(project: Project, name: string): Promise<[string, string]> {
  const std = join(work, `${name}-std.mp4`)
  const seg = join(work, `${name}-seg.mp4`)
  await exportProject({
    project,
    aspectRatio: '16:9',
    resolutionHeight: 180 as never,
    quality: 'standard',
    outputPath: std,
    telopLayer: null,
    onProgress: () => {}
  })
  await exportSequenceSegmented({
    project: projectV1ToV2(project, { resolution: 180 }),
    outputPath: seg,
    quality: 'standard',
    encoder: 'libx264',
    telopLayer: null
  })
  return [std, seg]
}

let still: MediaAsset
let video: MediaAsset
const projectOf = (clips: unknown[]): Project =>
  ({
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [still, video],
    clips,
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: []
  }) as unknown as Project

beforeAll(async () => {
  const png = join(work, 'red.png')
  await ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-frames:v', '1', png])
  const mp4 = join(work, 'blue.mp4')
  await ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x180:r=30:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=3:sample_rate=48000',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-t',
    '3',
    mp4
  ])
  still = await assetOf('S', png, {
    still: true,
    hasAudio: false,
    duration: STILL_DURATION_SEC,
    fps: 30
  } as Partial<MediaAsset>)
  video = await assetOf('V', mp4)
}, 60_000)

describe('入点が後ろにある静止画の本編クリップ', () => {
  it('分割した静止画の後ろ半分も、標準の書き出しで尺どおりに映る(区間ごとと同じ)', async () => {
    const [std, seg] = await both(
      projectOf([
        { id: 'c0', assetId: 'V', inPoint: 0, outPoint: 2, speed: 1 },
        { id: 'c1', assetId: 'S', inPoint: 0, outPoint: 2, speed: 1 },
        { id: 'c2', assetId: 'S', inPoint: 2, outPoint: 4, speed: 1 },
        { id: 'c3', assetId: 'V', inPoint: 0, outPoint: 2, speed: 1 }
      ]),
      'cut'
    )
    for (const out of [std, seg]) {
      const s = await streams(out)
      // 直す前の標準の書き出しは 180枚(6.0秒)・音声 8.0秒
      expect(s.frames, out).toBe(240)
      expect(s.audio, out).toBeCloseTo(8, 1)
      // 5.0秒は c2(静止画の後ろ半分)の中: 赤。7.0秒は最後の動画: 青
      const red = await rgbAt(out, 5)
      expect(red[0], out).toBeGreaterThan(200)
      expect(red[2], out).toBeLessThan(60)
      const blue = await rgbAt(out, 7)
      expect(blue[2], out).toBeGreaterThan(200)
    }
  }, 60_000)

  it('頭を詰めた静止画を繋ぎ(クロスフェード)で挟んでも、映像が途中で止まらない', async () => {
    const [std, seg] = await both(
      projectOf([
        { id: 'c0', assetId: 'V', inPoint: 0, outPoint: 2, speed: 1 },
        {
          id: 'c2',
          assetId: 'S',
          inPoint: 2,
          outPoint: 4,
          speed: 1,
          transitionIn: { type: 'crossfade', duration: 0.5 }
        },
        {
          id: 'c3',
          assetId: 'V',
          inPoint: 0,
          outPoint: 2,
          speed: 1,
          transitionIn: { type: 'crossfade', duration: 0.5 }
        }
      ]),
      'xfade'
    )
    for (const out of [std, seg]) {
      // 直す前の標準の書き出しは 62枚(2.07秒)で止まり、音声は 5.0秒
      expect((await streams(out)).frames, out).toBe(150)
      // 2.5秒は静止画だけが映る所: 赤
      expect((await rgbAt(out, 2.5))[0], out).toBeGreaterThan(200)
    }
  }, 60_000)
})

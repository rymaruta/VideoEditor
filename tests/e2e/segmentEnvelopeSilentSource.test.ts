import { execFile } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath, ffprobePath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 区間ごとの書き出しで、読む範囲に音が1サンプルも無い音のアイテム(音声が先に終わる録画の後ろ・
 * 音声が遅れて始まる録画の頭)に繋ぎ・フェードの音量の式が掛かっても、書き出しが失敗しないこと。
 * `apad` の出す時刻の無い無音が `aeval` の `t` を NaN にし、AAC が
 * `Terminating thread with return code -22` で止まっていた(標準の書き出しは成功していた)。
 */
const run = promisify(execFile)
const work = mkdtempSync(join(tmpdir(), 've-segnan-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = async (args: string[]): Promise<void> => {
  await run(ffmpegPath, ['-y', '-v', 'error', ...args])
}

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

const projectOf = (asset: MediaAsset, clips: unknown[]): Project =>
  ({
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [asset],
    clips,
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: []
  }) as unknown as Project

async function audioSeconds(path: string): Promise<number> {
  const { stdout } = await run(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=duration',
    '-of',
    'csv=p=0',
    path
  ])
  return Number(stdout.trim())
}

/** [from, to) 秒の音の実効値(モノラル 48kHz) */
async function rms(path: string, from: number, to: number): Promise<number> {
  const { stdout } = await run(
    ffmpegPath,
    ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 26 }
  )
  const x = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4)
  let s = 0
  let n = 0
  for (let i = Math.round(from * 48000); i < Math.min(x.length, Math.round(to * 48000)); i++) {
    s += x[i] * x[i]
    n++
  }
  return n ? Math.sqrt(s / n) : 0
}

async function segmented(project: Project, name: string): Promise<string> {
  const out = join(work, `${name}.mp4`)
  await exportSequenceSegmented({
    project: projectV1ToV2(project, { resolution: 180 }),
    outputPath: out,
    quality: 'standard',
    encoder: 'libx264',
    telopLayer: null
  })
  return out
}

describe('区間ごとの書き出し: 音の無い範囲に掛かる音量の式', () => {
  it('音声が先に終わった後ろを繋ぎ付きで使っても書き出せ、その範囲は無音になる', async () => {
    // 映像6秒・音声3秒の録画
    const path = join(work, 'short-audio.mp4')
    await ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=6',
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
      path
    ])
    const asset = await assetOf('V', path)
    const out = await segmented(
      projectOf(asset, [
        { id: 'c1', assetId: 'V', inPoint: 0, outPoint: 2, speed: 1 },
        {
          id: 'c2',
          assetId: 'V',
          inPoint: 3.5,
          outPoint: 5.5,
          speed: 1,
          transitionIn: { type: 'crossfade', duration: 0.5 }
        }
      ]),
      'tail'
    )
    // 直す前はここで書き出しごと失敗していた
    expect(await audioSeconds(out)).toBeCloseTo(3.5, 1)
    expect(await rms(out, 0.2, 1.2)).toBeGreaterThan(0.1)
    expect(await rms(out, 2.2, 3.4)).toBeLessThan(0.001)
  }, 60_000)

  it('音声が1秒遅れて始まる録画の頭を、繋ぎで次へ溶かしても書き出せる', async () => {
    const path = join(work, 'late-audio.mp4')
    await ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=6',
      '-itsoffset',
      '1',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=5:sample_rate=48000',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      path
    ])
    const asset = await assetOf('L', path)
    const out = await segmented(
      projectOf(asset, [
        { id: 'c1', assetId: 'L', inPoint: 0, outPoint: 0.9, speed: 1 },
        {
          id: 'c2',
          assetId: 'L',
          inPoint: 2,
          outPoint: 5,
          speed: 1,
          transitionIn: { type: 'crossfade', duration: 0.3 }
        }
      ]),
      'head'
    )
    expect(await audioSeconds(out)).toBeCloseTo(3.6, 1)
    // c1 は音の始まる前なので無音、c2 は音がある
    expect(await rms(out, 0, 0.5)).toBeLessThan(0.001)
    expect(await rms(out, 1.5, 3)).toBeGreaterThan(0.1)
  }, 60_000)
})

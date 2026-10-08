import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** 素材の取り込みの端: 回転情報・奇数の高さ・読めない静止画 */
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { exportProject, ffmpegPath, probeMedia } from '@main/ffmpegService'
import { ensurePreviewProxy } from '@main/previewProxyService'
import type { MediaAsset, Project } from '@shared/types'

const work = mkdtempSync(join(tmpdir(), 've-import-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))
const ff = (args: string[]): void => void execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])

/** JPEG の頭に、向き(Orientation)だけを持つ EXIF を差し込む */
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00, // II*  IFD は 8 バイト目
    0x01,
    0x00, // 項目 1 つ
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00, // Orientation
    0x00,
    0x00,
    0x00,
    0x00 // 次の IFD なし
  ])
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff])
  const len = Buffer.alloc(2)
  len.writeUInt16BE(body.length + 2)
  return Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([0xff, 0xe1]),
    len,
    body,
    jpeg.subarray(2)
  ])
}

describe.skipIf(!existsSync(ffmpegPath))('素材の取り込みの端', () => {
  it('Matroska の回転・写真の EXIF の向きも、縦横を回した後の大きさで測る', async () => {
    const plain = join(work, 'plain.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=640x360:r=30:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      plain
    ])
    const mkv = join(work, 'rot90.mkv')
    ff(['-display_rotation', '90', '-i', plain, '-c', 'copy', mkv])
    expect(await probeMedia(mkv)).toMatchObject({ width: 360, height: 640 })
    const jpg = join(work, 'photo.jpg')
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', jpg])
    const rotated = join(work, 'photo6.jpg')
    writeFileSync(rotated, withExifOrientation(readFileSync(jpg), 6))
    expect(await probeMedia(rotated)).toMatchObject({ width: 360, height: 640 })
    // 回転していない素材はそのまま
    expect(await probeMedia(jpg)).toMatchObject({ width: 640, height: 360 })
    // 縦長に記録して横長に見せる素材(画素が正方形でない)は回転ではない
    const anamorphic = join(work, 'half-d1.mkv')
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=352x480:r=30:d=1',
      '-vf',
      'setsar=20/11',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      anamorphic
    ])
    expect(await probeMedia(anamorphic)).toMatchObject({ width: 640, height: 480 })
  }, 60_000)

  it('高さが奇数の素材も、プレビュー用の変換ができる', async () => {
    const odd = join(work, 'odd.avi')
    ff(['-f', 'lavfi', '-i', 'testsrc=s=640x361:r=30:d=1', '-c:v', 'mjpeg', odd])
    const proxy = await ensurePreviewProxy(odd)
    const p = await probeMedia(proxy)
    expect(p.height % 2).toBe(0)
  }, 120_000)

  it('読めない静止画(動く WebP)を使った企画は、書き出しを止まらせずにすぐ断る', async () => {
    const anim = join(work, 'sticker.webp')
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=1:r=10', '-c:v', 'libwebp', '-loop', '0', anim])
    expect((await probeMedia(anim)).width).toBe(0)
    const main = join(work, 'main.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x180:r=30:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      main
    ])
    const m = await probeMedia(main)
    const asset = (a: Partial<MediaAsset>): MediaAsset =>
      ({ fps: 30, hasAudio: false, hasVideo: true, ...a }) as MediaAsset
    const project = {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [
        asset({
          id: 'm',
          filePath: main,
          fileName: 'main',
          duration: m.duration,
          width: 320,
          height: 180
        }),
        asset({
          id: 's',
          filePath: anim,
          fileName: 'sticker.webp',
          duration: 3600,
          width: 0,
          height: 0,
          still: true
        })
      ],
      clips: [{ id: 'c', assetId: 'm', inPoint: 0, outPoint: 2, speed: 1 }],
      audioTracks: [],
      videoOverlayTracks: [
        {
          id: 't',
          name: 'w',
          hidden: false,
          position: 'bottom-right',
          scale: 0.3,
          clips: [{ id: 'o', assetId: 's', startTime: 0, inPoint: 0, outPoint: 2 }]
        }
      ],
      textOverlays: []
    } as unknown as Project
    await expect(
      exportProject({
        project,
        aspectRatio: '16:9',
        resolutionHeight: 720,
        quality: 'standard',
        outputPath: join(work, 'out.mp4'),
        telopLayer: null,
        onProgress: () => {}
      })
    ).rejects.toThrow('静止画として読めない')
  }, 60_000)

  it('音声トラックが音の無い素材を指していても、標準の書き出しは失敗せずに鳴らさない', async () => {
    const main = join(work, 'main2.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x180:r=30:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      main
    ])
    const m = await probeMedia(main)
    const project = {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [
        {
          id: 'm',
          filePath: main,
          fileName: 'main',
          duration: m.duration,
          width: 320,
          height: 180,
          fps: 30,
          hasAudio: false,
          hasVideo: true
        }
      ],
      clips: [{ id: 'c', assetId: 'm', inPoint: 0, outPoint: 2, speed: 1 }],
      audioTracks: [
        {
          id: 'bgm',
          name: 'BGM',
          volume: 1,
          muted: false,
          duckingEnabled: false,
          clips: [{ id: 'b', assetId: 'm', startTime: 0, inPoint: 0, outPoint: 2 }]
        }
      ],
      videoOverlayTracks: [],
      textOverlays: []
    } as unknown as Project
    const out = join(work, 'silent.mp4')
    await exportProject({
      project,
      aspectRatio: '16:9',
      resolutionHeight: 720,
      quality: 'standard',
      outputPath: out,
      telopLayer: null,
      onProgress: () => {}
    })
    expect((await probeMedia(out)).duration).toBeGreaterThan(1.5)
  }, 60_000)
})

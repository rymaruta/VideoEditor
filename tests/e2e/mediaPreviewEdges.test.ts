import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false, getAppPath: () => process.cwd() }
}))

import { ffmpegPath, generateThumbnailDataUrl, generateWaveformDataUrl } from '@main/ffmpegService'

const work = mkdtempSync(join(tmpdir(), 've-preview-edges-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = (args: string[]): void => void execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])

describe.skipIf(!existsSync(ffmpegPath))('サムネイル・波形の端の扱い', () => {
  it('映像が音声より先に終わる素材でも、映像の終わりより後ろのサムネイルは最後の1枚', async () => {
    const src = join(work, 'short-video.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=8',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      src
    ])
    for (const t of [5, 7.95]) {
      await expect(generateThumbnailDataUrl(src, t)).resolves.toMatch(/^data:image\/jpeg;base64,/)
    }
  }, 60_000)

  it('音声が遅れて始まる素材の波形は、鳴った時刻の所に描く', async () => {
    const src = join(work, 'late.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=30:d=4',
      '-itsoffset',
      '0.5',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(between(t,2,2.1),0.8*sin(2*PI*1000*t),0)':d=3.5:s=48000",
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      src
    ])
    const url = await generateWaveformDataUrl(src, 0, 3, 300, 40)
    const png = Buffer.from(url.split(',')[1], 'base64')
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    // 列ごとに描かれた画素の数。一番多い列が鳴った時刻(ファイルの 2.5 秒 = 300px 中 250)
    let best = 0
    let bestCount = -1
    for (let x = 0; x < info.width; x++) {
      let count = 0
      for (let y = 0; y < info.height; y++) if (data[(y * info.width + x) * 4 + 3] > 0) count++
      if (count > bestCount) {
        bestCount = count
        best = x
      }
    }
    expect(Math.abs(best - 250)).toBeLessThanOrEqual(4)
  }, 60_000)
})

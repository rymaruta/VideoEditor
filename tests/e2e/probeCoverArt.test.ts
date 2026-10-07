import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath, probeMedia } from '@main/ffmpegService'

/** ジャケット画像の入った音声ファイル(よくある BGM)を、映像として扱わない */
const work = mkdtempSync(join(tmpdir(), 've-cover-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe.skipIf(!existsSync(ffmpegPath))('ジャケット画像付きの音声', () => {
  it('映像の無い音声ファイルとして読む', async () => {
    const cover = join(work, 'cover.png')
    execFileSync(ffmpegPath, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=64x64',
      '-frames:v',
      '1',
      cover
    ])
    const mp3 = join(work, 'BGM 曲名.mp3')
    execFileSync(ffmpegPath, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=2',
      '-i',
      cover,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'libmp3lame',
      '-c:v',
      'png',
      '-disposition:v',
      'attached_pic',
      mp3
    ])
    const p = await probeMedia(mp3)
    expect(p.hasAudio).toBe(true)
    expect(p.hasVideo).toBe(false)
  })
})

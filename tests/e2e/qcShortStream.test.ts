import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))
import { ffmpegPath } from '@main/ffmpegService'
import { measureExport } from '@main/qcService'
import { mediaIssues } from '@shared/qc/media'

/** 書き出しの自動確認: 映像・音声の片方だけが途中で終わった書き出しを見逃さない */
const work = mkdtempSync(join(tmpdir(), 've-qcshort-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const make = (name: string, videoSec: number, audioSec: number): string => {
  const out = join(work, name)
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=320x180:r=30:d=${videoSec}`,
    '-f',
    'lavfi',
    '-i',
    `sine=f=440:d=${audioSec}:sample_rate=48000`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    out
  ])
  return out
}

describe.skipIf(!existsSync(ffmpegPath))('片方だけ途中で終わった書き出し', () => {
  it('映像が先に終われば止まった画、音声が先に終われば無音として知らせる。そろっていれば何も言わない', async () => {
    const kinds = async (path: string): Promise<string[]> =>
      mediaIssues(await measureExport(path, () => {}), 'off').map((i) => i.kind)
    expect(await kinds(make('video-short.mp4', 4, 8))).toContain('freeze')
    expect(await kinds(make('audio-short.mp4', 8, 4))).toContain('silence')
    expect(await kinds(make('ok.mp4', 8, 8))).toEqual([])
  }, 120_000)

  it('音が映像より遅れて始まる書き出しは、頭の無音を知らせる(ファイルの終わりより先は言わない)', async () => {
    const out = join(work, 'late-audio.mp4')
    execFileSync(ffmpegPath, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=6',
      '-itsoffset',
      '3',
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
      out
    ])
    const m = await measureExport(out, () => {})
    expect(m.silence.some((s) => s.start < 0.5 && s.end > 2.5)).toBe(true)
    expect(m.silence.every((s) => s.end <= 6.2)).toBe(true)
  }, 60_000)
})

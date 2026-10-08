import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** 透過の素材(版面CG)の試聴用の素材も、書き出しと同じ大きさで聞かせる */
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { ffmpegPath } from '@main/ffmpegService'
import { ensurePreviewProxy, needsPreviewProxy } from '@main/previewProxyService'

const work = mkdtempSync(join(tmpdir(), 've-alphaaudio-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

function leftDb(path: string): number {
  const raw = execFileSync(
    ffmpegPath,
    ['-v', 'error', '-i', path, '-vn', '-af', 'pan=mono|c0=c0', '-ar', '48000', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 26 }
  )
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  let s = 0
  const from = 24000
  const to = Math.min(x.length, 48000 * 2)
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return 10 * Math.log10(s / (to - from))
}

describe.skipIf(!existsSync(ffmpegPath))('透過の素材の試聴用の音', () => {
  it('モノラルの音は、元と同じ大きさ(3dB 小さくしない)', async () => {
    const src = join(work, 'cg.mov')
    execFileSync(ffmpegPath, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red@0.5:s=320x180:d=3,format=yuva444p10le',
      '-f',
      'lavfi',
      '-i',
      'sine=f=200:d=3:sample_rate=48000,volume=0.3',
      '-shortest',
      '-c:v',
      'prores_ks',
      '-profile:v',
      '4444',
      '-pix_fmt',
      'yuva444p10le',
      '-c:a',
      'pcm_s16le',
      '-ac',
      '1',
      src
    ])
    const proxy = await ensurePreviewProxy(src)
    expect(proxy.endsWith('.webm')).toBe(true)
    expect(Math.abs(leftDb(proxy) - leftDb(src))).toBeLessThan(1)
  }, 120_000)
})

describe('4.0 の音声の試聴', () => {
  it('4.0 の素材は、書き出しと同じ畳み方の試聴用素材で聞かせる(quad はそのまま)', () => {
    expect(needsPreviewProxy('h264', 'aac', true, true, 4, '4.0')).toBe(true)
    expect(needsPreviewProxy('h264', 'aac', true, true, 4, 'quad')).toBe(false)
    expect(needsPreviewProxy('h264', 'aac', true, true, 2, 'stereo')).toBe(false)
  })
})

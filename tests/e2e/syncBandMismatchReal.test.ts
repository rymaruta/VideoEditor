/**
 * 片方の録音に低域カットがある2本の同期を、本物の ffmpeg・本物の同期の Worker で確かめる。
 * (実地テスト: 音楽・効果音の多い所で片方に 200Hz の低域カット → ずれは正しいのに確からしさ 27 で「合わない」)
 * - 正しい組: 「合う」とし、置き方の誤差が 10ms 以内
 * - 関係のない組: 「合わない」
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => ({ cacheDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.cacheDir, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { ffmpegPath, ffprobePath } from '@main/ffmpegService'
import type { SyncInputFile } from '@shared/sync/report'
import { runSyncWorker } from './syncWorkerThread'
import { movieLike, rerecord } from '../helpers/movieAudio'

const HAVE_FFMPEG = existsSync(ffmpegPath) && existsSync(ffprobePath)
const SR = 16000
const execFileAsync = promisify(execFile)

async function writeWav(path: string, x: Float32Array): Promise<void> {
  const buf = Buffer.alloc(44 + x.length * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + x.length * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(x.length * 2, 40)
  const view = new Int16Array(buf.buffer, buf.byteOffset + 44, x.length)
  for (let i = 0; i < x.length; i++) view[i] = Math.round(Math.max(-1, Math.min(1, x[i])) * 32767)
  await writeFile(path, buf)
}

/** カメラの音: 低域カット(ffmpeg の highpass=200Hz)を掛けた AAC 48kHz の m4a */
async function writeCutAac(path: string, x: Float32Array, dir: string): Promise<void> {
  const wav = join(dir, 'cam_src.wav')
  await writeWav(wav, x)
  await execFileAsync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-i',
    wav,
    '-af',
    'highpass=f=200',
    '-ar',
    '48000',
    '-c:a',
    'aac',
    path
  ])
  rmSync(wav, { force: true })
}

const input = (
  id: string,
  path: string,
  kind: 'mic' | 'camera',
  duration: number
): SyncInputFile => {
  const st = statSync(path)
  return {
    id,
    path,
    sourceId: kind === 'mic' ? 'M' : 'C',
    sourceKind: kind,
    duration,
    size: st.size,
    mtimeMs: st.mtimeMs
  }
}

describe.skipIf(!HAVE_FFMPEG)('片方に低域カットのある録音の同期', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 've-syncband-'))
    state.cacheDir = join(dir, 'userdata')
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('正しい組は 10ms 以内で合わせ、関係のない組は合わせない', async () => {
    const T = 110
    const CAM_START = 15
    const CAM_LEN = 85
    const movie = movieLike(T, SR, 4)
    const micPath = join(dir, 'mic.wav')
    await writeWav(micPath, rerecord(movie, 1, 0.003, 9))
    const camPath = join(dir, 'cam.m4a')
    await writeCutAac(
      camPath,
      rerecord(movie.subarray(CAM_START * SR, (CAM_START + CAM_LEN) * SR), 0.7, 0.003, 10),
      dir
    )
    const right = await runSyncWorker(
      [input('mic', micPath, 'mic', T), input('cam', camPath, 'camera', CAM_LEN)],
      ffmpegPath,
      state.cacheDir
    )
    const pair = right.pairs[0]
    expect(pair?.reliable, JSON.stringify(pair)).toBe(true)
    const m = right.placements.find((p) => p.id === 'mic')!
    const c = right.placements.find((p) => p.id === 'cam')!
    // カメラの頭はマイクの 15 秒
    expect(Math.abs(c.start - m.start - CAM_START), JSON.stringify(right.placements)).toBeLessThan(
      0.01
    )

    const otherPath = join(dir, 'other.m4a')
    await writeCutAac(otherPath, rerecord(movieLike(CAM_LEN, SR, 78), 0.7, 0.003, 11), dir)
    const wrong = await runSyncWorker(
      [input('mic', micPath, 'mic', T), input('cam', otherPath, 'camera', CAM_LEN)],
      ffmpegPath,
      state.cacheDir
    )
    expect(
      wrong.pairs.every((p) => !p.reliable),
      JSON.stringify(wrong.pairs)
    ).toBe(true)
  }, 300_000)
})

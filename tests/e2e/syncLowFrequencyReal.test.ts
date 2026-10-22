/**
 * 共通の音が低音(キック)だけの2本の同期を、本物の ffmpeg・本物の同期の Worker で確かめる。
 * 声の帯域に絞った相関だけでは、マイクごとに違う会場のざわめきだけが残って「合わない」になっていた。
 * - 正しい組: 「合う」とし、置き方の誤差が 10ms 以内
 * - 関係のない組(別のキック): 「合わない」
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { club, crowd, rerecord } from '../helpers/movieAudio'

const HAVE_FFMPEG = existsSync(ffmpegPath) && existsSync(ffprobePath)
const SR = 16000

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

describe.skipIf(!HAVE_FFMPEG)('低音が主の素材(クラブ・ライブ)の同期', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 've-synclow-'))
    state.cacheDir = join(dir, 'userdata')
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('共通の音がキックだけの正しい組は 10ms 以内で合わせ、関係のない組は合わせない', async () => {
    const T = 110
    const CAM_START = 15
    const CAM_LEN = 85
    const kick = club(T, 5, 0.05, SR)
    const micPath = join(dir, 'mic.wav')
    await writeWav(micPath, crowd(rerecord(kick, 1, 0.003, 9), 21, 0.03, 0.06, SR))
    const camPath = join(dir, 'cam.wav')
    await writeWav(
      camPath,
      crowd(
        rerecord(kick.subarray(CAM_START * SR, (CAM_START + CAM_LEN) * SR), 0.7, 0.003, 10),
        22,
        0.03,
        0.06,
        SR
      )
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
    expect(Math.abs(c.start - m.start - CAM_START), JSON.stringify(right.placements)).toBeLessThan(
      0.01
    )

    const otherPath = join(dir, 'other.wav')
    await writeWav(
      otherPath,
      crowd(rerecord(club(CAM_LEN, 31, 0.05, SR), 0.7, 0.003, 11), 81, 0.03, 0.06, SR)
    )
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

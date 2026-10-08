import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false, getAppPath: () => process.cwd() }
}))
/** 音声認識が返す結果(ここで差し替える) */
let fake: unknown = null
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: async () => async () => fake
}))

import { transcribeRange } from '@main/whisperService'
import { ffmpegPath } from '@main/ffmpegService'

const work = mkdtempSync(join(tmpdir(), 've-quiet-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
const ff = (args: string[]): void => void execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])
const STOCK = 'ご視聴ありがとうございました'

describe.skipIf(!existsSync(ffmpegPath))('区間の文字起こしの決まり文句', () => {
  it('部屋の雑音(-44dBFS)の上に出た決まり文句は作り話として捨てる', async () => {
    const src = join(work, 'room.wav')
    ff(['-f', 'lavfi', '-i', 'anoisesrc=c=white:a=0.0104:d=10:r=48000', src])
    fake = { text: STOCK, chunks: [{ text: STOCK, timestamp: [7, null] }] }
    expect(await transcribeRange(src, 0, 10)).toEqual([])
  }, 60_000)

  it('話し声の後ろの無音に出た決まり文句は捨て、話した所は残す', async () => {
    const src = join(work, 'tail.wav')
    ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.1*sin(2*PI*300*t)':d=5:s=48000",
      '-af',
      'apad=whole_dur=20',
      src
    ])
    fake = {
      text: 'こんにちは' + STOCK,
      chunks: [
        { text: 'こんにちは', timestamp: [0, 4.6] },
        { text: STOCK, timestamp: [4.6, null] }
      ]
    }
    expect((await transcribeRange(src, 0, 20)).map((s) => s.text)).toEqual(['こんにちは'])
  }, 60_000)

  it('小さな声で本当に言った締めの言葉は、後ろが長い無音でも残す', async () => {
    const src = join(work, 'real.wav')
    ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.01414*sin(2*PI*300*t)':d=1.5:s=48000",
      '-af',
      'apad=whole_dur=20',
      src
    ])
    fake = { text: STOCK, chunks: [{ text: STOCK, timestamp: [0, null] }] }
    expect((await transcribeRange(src, 0, 20)).map((s) => s.text)).toEqual([STOCK])
  }, 60_000)
})

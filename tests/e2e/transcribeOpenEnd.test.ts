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

import { transcribeRange, transcribeWordsRange } from '@main/whisperService'
import { ffmpegPath } from '@main/ffmpegService'

/**
 * 認識が終わりの時刻を返さない(null)区切り・言葉の扱い。
 * - 区切り: 区間の終わりまで伸ばすが、伸ばした長さで「遅すぎる繰り返し」と判定して捨てない
 *   (6〜12 秒に伸びた「はい、はい、はい」「そうそうそう」が消えていた)
 * - 言葉: 長さ 0 にすると長さ 0 の区切りとして捨てられる(間を空けた最後の「はい」{5〜5} が消えていた)
 */
const work = mkdtempSync(join(tmpdir(), 've-openend-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
const src = join(work, 'voice.wav')

describe.skipIf(!existsSync(ffmpegPath))('終わりの時刻が分からない認識結果', () => {
  it('区間の終わりまで伸ばした区切りの、ゆっくりした「はい、はい、はい」を残す', async () => {
    execFileSync(ffmpegPath, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.1*sin(2*PI*220*t)':d=12:s=16000",
      src
    ])
    for (const text of ['はい、はい、はい', 'そうそうそう']) {
      fake = { text, chunks: [{ text, timestamp: [6, null] }] }
      expect(await transcribeRange(src, 0, 12)).toEqual([{ start: 6, end: 12, text }])
    }
  }, 60_000)

  it('終わりの返らない最後の言葉に長さを与えて残す', async () => {
    fake = {
      text: 'はい、それでは。はい',
      chunks: [
        { text: 'はい、', timestamp: [0.5, 0.9] },
        { text: 'それでは。', timestamp: [1, 1.6] },
        { text: 'はい', timestamp: [5, null] }
      ]
    }
    const segs = await transcribeWordsRange(src, 0, 12)
    expect(segs.map((s) => s.text)).toEqual(['はい、それでは。', 'はい'])
    const last = segs[1]
    expect(last.start).toBe(5)
    expect(last.end).toBeGreaterThan(5.2)
    expect(last.end).toBeLessThanOrEqual(6.5)
    // 区間の終わりを越えない
    fake = { text: 'はい', chunks: [{ text: 'はい', timestamp: [11.9, null] }] }
    const tail = await transcribeWordsRange(src, 0, 12)
    expect(tail.map((s) => [s.text, s.start])).toEqual([['はい', 11.9]])
    expect(tail[0].end).toBeLessThanOrEqual(12)
    expect(tail[0].end).toBeGreaterThan(11.9)
  }, 60_000)
})

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

  it('頭に無音がある区間でも、部屋の雑音の上の決まり文句は捨てる', async () => {
    const src = join(work, 'lead-silence.wav')
    ff([
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=c=white:a=0.0104:d=8:r=48000',
      '-af',
      'adelay=2000:all=1',
      src
    ])
    fake = { text: STOCK, chunks: [{ text: STOCK, timestamp: [7, null] }] }
    expect(await transcribeRange(src, 0, 10)).toEqual([])
  }, 60_000)

  it('短く(1.3秒)言った締めの言葉も、終わりが分からなくても残す', async () => {
    const src = join(work, 'short-real.wav')
    // 音節のように途切れる声(-30dBFS ほど)を 1.3 秒、あとは無音
    ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.045*sin(2*PI*180*t)*gt(sin(2*PI*5*t),-0.3)':d=1.3:s=48000",
      '-af',
      'apad=whole_dur=20',
      src
    ])
    fake = { text: STOCK, chunks: [{ text: STOCK, timestamp: [0, null] }] }
    expect((await transcribeRange(src, 0, 20)).map((x) => x.text)).toEqual([STOCK])
  }, 60_000)

  it('ノイズゲートのマイクで小さく言った締めの言葉(言葉の間が 0)も残す', async () => {
    const src = join(work, 'gated.wav')
    // 音節の間をゲートが 0 にした、小さな声(-37dBFS ほど)を 10 秒
    ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.02*sin(2*PI*180*t)*gt(sin(2*PI*5*t),-0.3)':d=10:s=48000",
      src
    ])
    fake = { text: STOCK, chunks: [{ text: STOCK, timestamp: [8, null] }] }
    expect((await transcribeRange(src, 0, 10)).map((x) => x.text)).toEqual([STOCK])
  }, 60_000)

  it('頭・終わり・途中の短い無音(1秒未満)の隣でも、部屋の雑音の上の決まり文句は捨てる', async () => {
    const lead = join(work, 'shortlead.wav')
    ff([
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=c=white:a=0.0104:d=9.2:r=48000',
      '-af',
      'adelay=800:all=1',
      lead
    ])
    fake = { text: STOCK, chunks: [{ text: STOCK, timestamp: [0.9, null] }] }
    expect(await transcribeRange(lead, 0, 10)).toEqual([])
    const tail = join(work, 'shorttail.wav')
    ff([
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=c=white:a=0.0104:d=9.2:r=48000',
      '-af',
      'apad=whole_dur=10',
      tail
    ])
    fake = { text: STOCK, chunks: [{ text: STOCK, timestamp: [8.5, null] }] }
    expect(await transcribeRange(tail, 0, 10)).toEqual([])
    const cuts = join(work, 'shortcuts.wav')
    // 3・5・7 秒に 0.5 秒の無音(切った所)
    ff([
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=c=white:a=0.0104:d=10:r=48000',
      '-af',
      "volume='if(between(t,3,3.5)+between(t,5,5.5)+between(t,7,7.5),0,1)':eval=frame",
      cuts
    ])
    fake = { text: STOCK, chunks: [{ text: STOCK, timestamp: [5.6, null] }] }
    expect(await transcribeRange(cuts, 0, 10)).toEqual([])
  }, 60_000)

  it('録音の頭・終わりの無音が近くにあっても、部屋の雑音の上の決まり文句は捨てる', async () => {
    const lead = join(work, 'lead2.wav')
    ff([
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=c=white:a=0.0104:d=8:r=48000',
      '-af',
      'adelay=2000:all=1',
      lead
    ])
    fake = { text: STOCK, chunks: [{ text: STOCK, timestamp: [3, null] }] }
    expect(await transcribeRange(lead, 0, 10)).toEqual([])
    const tail = join(work, 'tail2.wav')
    ff([
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=c=white:a=0.0104:d=8:r=48000',
      '-af',
      'apad=whole_dur=12',
      tail
    ])
    fake = { text: STOCK, chunks: [{ text: STOCK, timestamp: [6, null] }] }
    expect(await transcribeRange(tail, 0, 12)).toEqual([])
  }, 60_000)
})

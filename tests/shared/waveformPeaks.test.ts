import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  WAVE_PEAKS_MAX_COLUMNS,
  WavePeakAccumulator,
  isWavePeaks,
  peakSampleRate,
  wavePeaksBytes,
  type GenerateWaveformPeaks,
  type WavePeaks
} from '@shared/waveformPeaks'
import { IPC } from '@shared/ipc'

/** 交互(L, R, …)に並べた音を作る */
function interleave(
  frames: number,
  l: (i: number) => number,
  r: (i: number) => number
): Float32Array {
  const out = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    out[i * 2] = l(i)
    out[i * 2 + 1] = r(i)
  }
  return out
}

describe('細かい波形の集計(WavePeakAccumulator)', () => {
  it('正弦波: 各列の最大・最小は ±振幅、RMS は振幅/√2。L/R は別に数える', () => {
    const rate = 16000
    const frames = rate // 1 秒
    const a = 0.5
    const sine = (i: number): number => a * Math.sin((2 * Math.PI * 440 * i) / rate)
    const acc = new WavePeakAccumulator(20, 2, frames)
    acc.push(interleave(frames, sine, () => 0))
    const p = acc.finish()
    expect(p.columns).toBe(20)
    expect(p.channels).toHaveLength(2)
    for (let k = 0; k < 20; k++) {
      expect(p.channels[0].max[k]).toBeCloseTo(a, 2)
      expect(p.channels[0].min[k]).toBeCloseTo(-a, 2)
      expect(p.channels[0].rms[k]).toBeCloseTo(a / Math.SQRT2, 2)
      expect(p.channels[1].max[k]).toBe(0)
      expect(p.channels[1].rms[k]).toBe(0)
    }
  })

  it('片側だけの音(半波): 最小は 0 のまま(上下を対称にしない)', () => {
    const frames = 8000
    const half = (i: number): number => Math.max(0, 0.8 * Math.sin((2 * Math.PI * i) / 80))
    const acc = new WavePeakAccumulator(10, 2, frames)
    acc.push(interleave(frames, half, (i) => -half(i)))
    const p = acc.finish()
    for (let k = 0; k < 10; k++) {
      expect(p.channels[0].max[k]).toBeCloseTo(0.8, 2)
      expect(p.channels[0].min[k]).toBe(0)
      expect(p.channels[1].max[k]).toBe(0)
      expect(p.channels[1].min[k]).toBeCloseTo(-0.8, 2)
    }
  })

  it('無音: すべて 0。NaN も無音として数える', () => {
    const acc = new WavePeakAccumulator(5, 2, 1000)
    const s = new Float32Array(2000)
    s[10] = Number.NaN
    acc.push(s)
    const p = acc.finish()
    for (const ch of p.channels) {
      expect(Array.from(ch.max)).toEqual([0, 0, 0, 0, 0])
      expect(Array.from(ch.min)).toEqual([0, 0, 0, 0, 0])
      expect(Array.from(ch.rms)).toEqual([0, 0, 0, 0, 0])
    }
  })

  it('チャンクの境目で L/R のフレームが割れても、同じ結果になる', () => {
    const frames = 3001
    const s = interleave(
      frames,
      (i) => Math.sin(i / 7),
      (i) => 0.3 * Math.cos(i / 3)
    )
    const whole = new WavePeakAccumulator(17, 2, frames)
    whole.push(s)
    const pieced = new WavePeakAccumulator(17, 2, frames)
    for (let i = 0; i < s.length; i += 333) pieced.push(s.subarray(i, i + 333)) // 奇数で割る
    expect(pieced.finish()).toEqual(whole.finish())
  })

  it('予定より多く届いた分は最後の列へ、列の数は上限で切る', () => {
    const acc = new WavePeakAccumulator(4, 1, 4)
    acc.push(new Float32Array([0, 0, 0, 0, 0.9, -0.9]))
    const p = acc.finish()
    expect(p.channels[0].max[3]).toBeCloseTo(0.9)
    expect(p.channels[0].min[3]).toBeCloseTo(-0.9)
    expect(new WavePeakAccumulator(1e9, 2, 10).finish().columns).toBe(WAVE_PEAKS_MAX_COLUMNS)
  })

  it('3 時間相当を流しても、使うメモリは列の数ぶんで一定(溜めない)', () => {
    // 3 時間 × 16kHz × 2ch = 3.456 億サンプル。同じ 1 つの塊を使い回して流す
    const rate = 16000
    const totalFrames = 3 * 3600 * rate
    const columns = 4000
    const acc = new WavePeakAccumulator(columns, 2, totalFrames)
    const chunkFrames = 1 << 16
    const chunk = interleave(
      chunkFrames,
      (i) => 0.25 * Math.sin(i / 5),
      (i) => -0.25 * Math.sin(i / 9)
    )
    const pushes = Math.floor(totalFrames / chunkFrames)
    const before = process.memoryUsage().heapUsed
    let peakDelta = 0
    for (let n = 0; n < pushes; n++) {
      acc.push(chunk)
      if (n % 256 === 0) peakDelta = Math.max(peakDelta, process.memoryUsage().heapUsed - before)
    }
    const p = acc.finish()
    // 集めた値そのものは 4000 列 × 2ch × 3 値 × 4 バイト ≒ 96KB
    expect(wavePeaksBytes(p)).toBe(columns * 2 * 3 * 4)
    // 流している間に増えたヒープは数 MB に収まる(音を溜めると 1.3GB になる)
    expect(peakDelta).toBeLessThan(32 * 1024 * 1024)
    expect(p.channels[0].max[columns - 2]).toBeGreaterThan(0.2)
  }, 120_000)
})

describe('細かい波形の IPC', () => {
  it('チャンネル名は他と重ならない', () => {
    const values = Object.values(IPC)
    expect(IPC.generateWaveformPeaks).toBe('media:waveformPeaks')
    expect(values.filter((v) => v === IPC.generateWaveformPeaks)).toHaveLength(1)
  })

  it('preload の関数の形と、structured clone を通った値が使えること', async () => {
    expectTypeOf<GenerateWaveformPeaks>().parameters.toEqualTypeOf<
      [string, number, number, number]
    >()
    expectTypeOf<GenerateWaveformPeaks>().returns.resolves.toEqualTypeOf<WavePeaks>()
    const acc = new WavePeakAccumulator(3, 2, 3)
    acc.push(new Float32Array([0.1, -0.2, 0.3, -0.4, 0.5, -0.6]))
    const sent = structuredClone(acc.finish())
    expect(isWavePeaks(sent)).toBe(true)
    expect(isWavePeaks({ ...sent, version: 99 })).toBe(false)
    expect(isWavePeaks('data:image/png;base64,AAAA')).toBe(false)
    expect(isWavePeaks({ ...sent, channels: [{ max: [1], min: [1], rms: [1] }] })).toBe(false)
  })

  it('読む速さは 1 列に数サンプル以上、上限 48kHz', () => {
    expect(peakSampleRate(1000, 10)).toBe(16000)
    expect(peakSampleRate(60000, 1)).toBe(48000)
    expect(peakSampleRate(4000, 0.5)).toBe(48000)
  })
})

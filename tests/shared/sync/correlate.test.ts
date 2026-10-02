import { describe, expect, it } from 'vitest'
import { crossCorrelation, fftInPlace } from '../../../src/shared/sync/fft'
import {
  EnvelopeBuilder,
  isReliableMatch,
  matchFeatures,
  onsetFeature,
  refineOffset
} from '../../../src/shared/sync/correlate'

/** 再現できる乱数 */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** 話し声のような「鳴ったり止んだり」する音(8kHz) */
function speechLike(seconds: number, rate: number, seed: number): Float32Array {
  const r = rng(seed)
  const out = new Float32Array(Math.round(seconds * rate))
  let i = 0
  while (i < out.length) {
    const len = Math.round((0.08 + r() * 0.6) * rate)
    const on = r() < 0.55
    const amp = on ? 0.1 + r() * 0.8 : 0.01
    for (let j = 0; j < len && i < out.length; j++, i++) out[i] = amp * (r() * 2 - 1)
  }
  return out
}

/** 別の録音機で録ったことにする: 音量を変え、別の雑音を足す */
function rerecord(src: Float32Array, gain: number, noise: number, seed: number): Float32Array {
  const r = rng(seed)
  return src.map((v) => v * gain + noise * (r() * 2 - 1))
}

function feature(samples: Float32Array, rate: number): Float32Array {
  const b = new EnvelopeBuilder(rate)
  b.push(samples)
  return onsetFeature(b.finish())
}

describe('fft', () => {
  it('変換して戻すと元に戻る', () => {
    const re = Float64Array.from([1, 2, 3, 4, 0, -1, 2, 5])
    const im = new Float64Array(8)
    const orig = Float64Array.from(re)
    fftInPlace(re, im)
    fftInPlace(re, im, true)
    re.forEach((v, i) => expect(v).toBeCloseTo(orig[i], 9))
  })

  it('相互相関は素直な計算と一致する', () => {
    const a = [1, 3, -2, 4, 0.5]
    const b = [2, -1, 0.5]
    const c = crossCorrelation(a, b)
    for (let k = -(b.length - 1); k < a.length; k++) {
      let s = 0
      for (let t = 0; t < b.length; t++) if (t + k >= 0 && t + k < a.length) s += a[t + k] * b[t]
      expect(c[k + b.length - 1]).toBeCloseTo(s, 9)
    }
  })
})

describe('matchFeatures', () => {
  const rate = 8000
  const master = speechLike(400, rate, 7)

  it('途中から録り始めた素材の位置を 10ms 単位で見つける', () => {
    const a = rerecord(master.subarray(0, 300 * rate), 0.3, 0.01, 1)
    const b = rerecord(master.subarray(123.45 * rate, 210 * rate), 1.8, 0.03, 2)
    const m = matchFeatures(feature(a, rate), feature(b, rate))!
    expect(m.offset).toBeCloseTo(123.45, 1)
    expect(Math.abs(m.offset - 123.45)).toBeLessThanOrEqual(0.011)
    expect(isReliableMatch(m)).toBe(true)
  })

  it('b のほうが先に始まっていれば負になる', () => {
    const a = rerecord(master.subarray(50 * rate, 200 * rate), 1, 0.02, 3)
    const b = rerecord(master.subarray(20 * rate, 120 * rate), 0.5, 0.02, 4)
    const m = matchFeatures(feature(a, rate), feature(b, rate))!
    expect(Math.abs(m.offset - -30)).toBeLessThanOrEqual(0.011)
  })

  it('関係のない2本は確からしさが低い', () => {
    const a = rerecord(master.subarray(0, 120 * rate), 1, 0.02, 5)
    const other = speechLike(120, rate, 99)
    const m = matchFeatures(feature(a, rate), feature(other, rate))!
    expect(isReliableMatch(m)).toBe(false)
  })

  it('探す範囲を絞れる', () => {
    const a = rerecord(master.subarray(0, 300 * rate), 1, 0.02, 6)
    const b = rerecord(master.subarray(100 * rate, 160 * rate), 1, 0.02, 7)
    expect(
      matchFeatures(feature(a, rate), feature(b, rate), { searchRange: [90, 110] })!.offset
    ).toBeCloseTo(100, 1)
  })
})

describe('refineOffset', () => {
  it('1サンプル未満の精度まで詰める', () => {
    const rate = 16000
    const src = speechLike(30, rate, 11)
    const trueOffset = 0.0123 // b の頭は a の頭の 12.3ms 後
    const shift = Math.round(trueOffset * rate)
    const a = rerecord(src.subarray(0, 20 * rate), 1, 0.01, 1)
    // b の 0 は a の shift に当たる。粗い値 0.01 から詰める
    const coarse = 0.01
    const bStart = Math.round((0 - coarse) * rate) // b 時刻 s - coarse(s = 2秒から切る)
    const s = 2 * rate
    const aWin = a.subarray(s, s + 10 * rate)
    const bFull = rerecord(src.subarray(shift), 0.4, 0.01, 2)
    const bWin = bFull.subarray(s + bStart, s + bStart + 10 * rate)
    const r = refineOffset(aWin, bWin, rate, coarse)
    expect(Math.abs(r.offset - shift / rate)).toBeLessThan(0.0005)
    expect(r.sharpness).toBeGreaterThan(5)
  })
})

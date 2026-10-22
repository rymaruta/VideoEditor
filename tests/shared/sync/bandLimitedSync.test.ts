import { describe, expect, it } from 'vitest'
import {
  BandPass,
  EnvelopeBuilder,
  isReliableMatch,
  matchFeatures,
  onsetFeature
} from '../../../src/shared/sync/correlate'
import { highpass2, movieLike, rerecord } from '../../helpers/movieAudio'

/**
 * 片方の録音に低域カットがあると、正しいずれでも「合わない」になっていた(実地テスト: Tears of Steel の
 * 410〜530 秒・音楽と効果音が多い所で、片方に 200Hz の低域カット → ずれは正しく 15.000 秒だが確からしさ 27)。
 * 同期は両方を声の帯域に揃えた包絡線で比べる(`EnvelopeBuilder` の `band`。syncWorker が使う)
 */
const RATE = 8000

function feature(x: Float32Array, band: boolean): Float32Array {
  const b = new EnvelopeBuilder(RATE, { band })
  b.push(x)
  return onsetFeature(b.finish())
}

describe('録音機の周波数特性の違いに強い同期', () => {
  const movie = movieLike(140, RATE, 4)
  const a = rerecord(movie, 1, 0.003, 9)
  const cut = (hz: number): Float32Array =>
    rerecord(highpass2(movie.subarray(15 * RATE, 135 * RATE), hz, RATE), 0.7, 0.003, 10)

  it('片方に低域カット(200Hz・80Hz)があっても、声の帯域に揃えて正しいずれを「合う」とする', () => {
    for (const hz of [200, 80]) {
      const m = matchFeatures(feature(a, true), feature(cut(hz), true))!
      expect(Math.abs(m.offset - 15), `${hz}Hz`).toBeLessThanOrEqual(0.011)
      expect(isReliableMatch(m), `${hz}Hz 確からしさ ${m.confidence.toFixed(1)}`).toBe(true)
    }
    // 帯域を揃えないと、正しいずれでも確からしさが基準に届かない(直す前の動き)
    const plain = matchFeatures(feature(a, false), feature(cut(200), false))!
    expect(Math.abs(plain.offset - 15)).toBeLessThanOrEqual(0.011)
    expect(isReliableMatch(plain)).toBe(false)
  })

  it('関係のない素材は、帯域を揃えても「合わない」', () => {
    for (const seed of [77, 78, 79]) {
      const other = rerecord(highpass2(movieLike(120, RATE, seed), 200, RATE), 0.7, 0.003, seed)
      const m = matchFeatures(feature(a, true), feature(other, true))!
      expect(isReliableMatch(m), `seed ${seed} 確からしさ ${m.confidence.toFixed(1)}`).toBe(false)
    }
  })

  it('帯域通過: 1kHz はほぼそのまま、100Hz と 3.9kHz は大きく下げ、無音で NaN を出さない', () => {
    const gain = (hz: number): number => {
      const f = new BandPass(RATE)
      let peak = 0
      for (let i = 0; i < RATE; i++) {
        const y = f.step(Math.sin((2 * Math.PI * hz * i) / RATE))
        if (i > RATE / 2) peak = Math.max(peak, Math.abs(y))
      }
      return peak
    }
    expect(gain(1000)).toBeGreaterThan(0.9)
    expect(gain(1000)).toBeLessThan(1.1)
    expect(gain(100)).toBeLessThan(0.05)
    expect(gain(3900)).toBeLessThan(0.1)
    const f = new BandPass(RATE)
    f.step(1)
    let last = 1
    for (let i = 0; i < RATE * 10; i++) last = f.step(0)
    expect(Number.isFinite(last)).toBe(true)
    expect(Math.abs(last)).toBeLessThan(1e-9)
  })
})

import { describe, expect, it } from 'vitest'
import {
  ENVELOPE_RATE,
  isReliableMatch,
  matchFeatures,
  matchWithDrift
} from '../../../src/shared/sync/correlate'
import { seeded } from '../../helpers/boundary'

/** 音の立ち上がりの並び(点の列)を、時計の速さ `rate`・頭のずれ `offset` で録った2本目を作る */
function pair(
  seconds: number,
  offset: number,
  rate: number,
  seed: number
): { a: Float32Array; b: Float32Array } {
  const rnd = seeded(seed)
  const events: number[] = []
  for (let t = 1; t < seconds; t += 0.2 + rnd() * 1.5) events.push(t)
  const a = new Float32Array(Math.round(seconds * ENVELOPE_RATE))
  const bLen = Math.round((seconds - Math.max(0, offset) - 5) * rate * ENVELOPE_RATE)
  const b = new Float32Array(bLen)
  for (const t of events) {
    const amp = 1 + rnd() * 3
    a[Math.round(t * ENVELOPE_RATE)] += amp
    // a の t 秒は、b の時計では (t - offset) × rate 秒
    const tb = (t - offset) * rate
    const k = Math.round(tb * ENVELOPE_RATE)
    if (k >= 0 && k < bLen) b[k] += amp * (0.6 + rnd() * 0.4)
  }
  // 雑音
  for (let i = 0; i < a.length; i++) a[i] += (rnd() - 0.5) * 0.3
  for (let i = 0; i < b.length; i++) b[i] += (rnd() - 0.5) * 0.3
  return { a, b }
}

describe('時計がずれた長い2本の照らし合わせ', () => {
  it('丸ごとでは山がつぶれる 300ppm・15分でも、窓ごとに合わせてずれと速さを求める', () => {
    const { a, b } = pair(900, 0.733, 1.0003, 7)
    const whole = matchFeatures(a, b)
    expect(whole && isReliableMatch(whole)).toBeFalsy()
    const d = matchWithDrift(a, b)!
    expect(d).not.toBeNull()
    // offset は center の位置での値。b の時計が速いと、a の後ろほど b の頭は手前に見える
    // (a の c 秒 = b の (c - 0.733) × rate 秒 → その場で見た b の頭 = c - (c - 0.733) × rate)
    const expected = d.center - (d.center - 0.733) * 1.0003
    expect(Math.abs(d.offset - expected)).toBeLessThan(0.02)
    // 粗い速さ(10ms 刻みの窓から)。細かい速さは、このあと頭と終わりを波形で測り直して求める
    // (その探す幅 50ms に、見込みのずれが収まればよい: 60ppm × 5分 = 18ms)
    expect(Math.abs((d.rate - 1.0003) * 1e6)).toBeLessThan(60)
  })

  it('丸ごとの相関の山の周りだけを探しても同じ答え。500ppm は1分の窓で合う', () => {
    const { a, b } = pair(745, 0.733, 1.0005, 7)
    const around = matchFeatures(a, b)!.offset
    expect(matchWithDrift(a, b, { around })).toBeNull()
    const d = matchWithDrift(a, b, { around, windowSec: 60, maxWindows: 12 })!
    expect(Math.abs((d.rate - 1.0005) * 1e6)).toBeLessThan(60)
    const expected = d.center - (d.center - 0.733) * 1.0005
    expect(Math.abs(d.offset - expected)).toBeLessThan(0.03)
  })

  it('関係のない2本は合わせない(1分の窓でも)', () => {
    for (let seed = 10; seed < 20; seed++) {
      const { a } = pair(900, 0, 1, seed)
      const { b } = pair(900, 0, 1, seed + 100)
      const around = matchFeatures(a, b)!.offset
      expect(matchWithDrift(a, b, { around })).toBeNull()
      expect(matchWithDrift(a, b, { around, windowSec: 60, maxWindows: 12 })).toBeNull()
    }
  })

  it('関係のない2本は合わせない', () => {
    const { a } = pair(900, 0, 1, 1)
    const { b } = pair(900, 0, 1, 2)
    expect(matchWithDrift(a, b)).toBeNull()
  })
})

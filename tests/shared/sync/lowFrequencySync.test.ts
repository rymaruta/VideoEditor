import { describe, expect, it } from 'vitest'
import {
  EnvelopeBuilder,
  isReliableMatch,
  matchWholeFile,
  matchWholeFileBoth,
  onsetFeature,
  type SyncFeatures
} from '../../../src/shared/sync/correlate'
import { club, crowd, highpass2, movieLike, rerecord, rng } from '../../helpers/movieAudio'

/**
 * 共通の音が低音だけの素材(クラブ・ライブ・イベント)の同期。
 * 声の帯域(250Hz〜3kHz)に絞った相関だけでは、共通のキック(45〜75Hz)が消え、マイクごとに違う会場の
 * ざわめきだけが残って「合わない」になっていた(実測: 絞ると 確からしさ 4〜5 で誤った位置、
 * 絞らなければ 15.000 秒・確からしさ 92〜100)。同期は絞った・絞らない両方で比べ、良いほうを使う
 * (`matchWholeFileBoth`。syncWorker が使う)。
 */
const RATE = 8000

function features(x: Float32Array): SyncFeatures {
  const band = new EnvelopeBuilder(RATE, { band: true })
  const plain = new EnvelopeBuilder(RATE)
  band.push(x)
  plain.push(x)
  return { band: onsetFeature(band.finish()), plain: onsetFeature(plain.finish()) }
}

const describeMatch = (m: { offset: number; confidence: number; distinctness: number }): string =>
  `offset ${m.offset.toFixed(3)} 確からしさ ${m.confidence.toFixed(1)} 抜け具合 ${m.distinctness.toFixed(2)}`

describe('低音が主の素材の同期(帯域を絞った・絞らない相関の良いほう)', () => {
  const cases = [
    { click: 0.05, lo: 0.03, hi: 0.06 },
    { click: 0, lo: 0.01, hi: 0.01 }
  ]

  it('共通の音がキックだけでも、15 秒のずれを 10ms 以内で「合う」とする', () => {
    for (const { click, lo, hi } of cases) {
      const w = club(140, 5, click, RATE)
      const a = features(crowd(rerecord(w, 1, 0.003, 9), 21, lo, hi, RATE))
      const b = features(
        crowd(rerecord(w.subarray(15 * RATE, 135 * RATE), 0.7, 0.003, 10), 22, lo, hi, RATE)
      )
      // 帯域を絞っただけでは合わない(直す前の動き)
      const banded = matchWholeFile(a.band, b.band)!
      expect(isReliableMatch(banded), describeMatch(banded)).toBe(false)
      const r = matchWholeFileBoth(a, b)!
      expect(r.band, describeMatch(r.match)).toBe(false)
      expect(Math.abs(r.match.offset - 15), describeMatch(r.match)).toBeLessThanOrEqual(0.011)
      expect(isReliableMatch(r.match), describeMatch(r.match)).toBe(true)
    }
  })

  it('片方に低域カット(200Hz)のある素材は、引き続き帯域を絞った相関で合う', () => {
    const movie = movieLike(140, RATE, 4)
    const a = features(rerecord(movie, 1, 0.003, 9))
    const b = features(
      rerecord(highpass2(movie.subarray(15 * RATE, 135 * RATE), 200, RATE), 0.7, 0.003, 10)
    )
    const r = matchWholeFileBoth(a, b)!
    expect(r.band, describeMatch(r.match)).toBe(true)
    expect(Math.abs(r.match.offset - 15)).toBeLessThanOrEqual(0.011)
    expect(isReliableMatch(r.match), describeMatch(r.match)).toBe(true)
  })

  it('関係のない素材(別のキック・別の映画の音・キックと映画)は、どちらの相関でも「合わない」', () => {
    const mic = features(
      crowd(rerecord(club(140, 5, 0.05, RATE), 1, 0.003, 9), 21, 0.03, 0.06, RATE)
    )
    const movie = features(rerecord(movieLike(140, RATE, 4), 1, 0.003, 9))
    const others = [
      ...[31, 32, 33].map((s) =>
        crowd(rerecord(club(120, s, 0.05, RATE), 0.7, 0.003, s), s + 50, 0.03, 0.06, RATE)
      ),
      ...[34, 35].map((s) =>
        crowd(rerecord(club(120, s, 0, RATE), 0.7, 0.003, s), s + 50, 0.01, 0.01, RATE)
      ),
      ...[77, 78].map((s) => rerecord(highpass2(movieLike(120, RATE, s), 200, RATE), 0.7, 0.003, s))
    ].map(features)
    const hits: string[] = []
    for (const [i, o] of others.entries()) {
      for (const [name, base] of [
        ['キック', mic],
        ['映画', movie]
      ] as const) {
        const r = matchWholeFileBoth(base, o)!
        if (isReliableMatch(r.match)) hits.push(`${name} × ${i}: ${describeMatch(r.match)}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('ほとんど無音の関係のない2本(まばらな物音)の偶然の山を、どちらの相関でも拾わない', () => {
    /** 20〜120 秒に1つの物音と、録音機の雑音だけの音 */
    const sparse = (seconds: number, seed: number): Float32Array => {
      const r = rng(seed)
      const out = new Float32Array(seconds * RATE)
      for (let i = 0; i < out.length; i++) out[i] = 0.002 * (r() * 2 - 1)
      for (let t = r() * 10; t < seconds; t += 20 + r() * 100) {
        const k0 = Math.round(t * RATE)
        const amp = 0.1 * (0.5 + r())
        for (let i = 0; i < 0.3 * RATE && k0 + i < out.length; i++)
          out[k0 + i] += amp * Math.exp(-i / RATE / 0.1) * (r() * 2 - 1)
      }
      return out
    }
    const hits: string[] = []
    for (const s of [8, 15, 36, 41]) {
      const r = matchWholeFileBoth(
        features(sparse(240, 3 * s + 1)),
        features(sparse(150, 3 * s + 2))
      )
      if (r && isReliableMatch(r.match)) hits.push(`${s}: ${describeMatch(r.match)}`)
    }
    expect(hits).toEqual([])
  })
})

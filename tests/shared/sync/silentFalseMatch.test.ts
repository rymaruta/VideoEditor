import { describe, expect, it } from 'vitest'
import {
  ENVELOPE_RATE,
  isReliableMatch,
  matchFeatures,
  matchWithDrift,
  onsetFeature
} from '../../../src/shared/sync/correlate'

/**
 * ほとんど無音の、関係のない2本(まばらな物音だけ)を合わせてしまわないこと。
 *
 * 相関の得点は √重なり で割るので、最短の重なり(15 秒)にたまたま物音が1つ重なっただけで、
 * 長い重なりの位置より何倍も高い得点になる。ばらつき(中央値・MAD)は長い重なりの位置で測るので
 * 確からしさが数百〜数万になり、2番目(別の偶然の1つ)との比も 1.8 を越えて「確か」と判断されていた。
 * 実測(下の種): 端の重なり 17〜35 秒の位置で 確からしさ 42〜762・抜け具合 1.86〜2.35。
 */

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Ev {
  t: number
  dur: number
  amp: number
  decay: number
}

/** まばらな物音(20〜120 秒に1つ) */
function sparse(T: number, seed: number): Ev[] {
  const r = rng(seed)
  const ev: Ev[] = []
  for (let t = r() * 10; t < T; t += 20 + r() * 100)
    ev.push({ t, dur: 0.3, amp: 0.1 * (0.5 + r()), decay: 0.1 })
  return ev
}

/** 録音機で見た 100Hz の RMS 包絡線(floor は雑音の大きさ) */
function record(world: Ev[], len: number, floor: number, seed: number): Float32Array {
  const n = Math.round(len * ENVELOPE_RATE)
  const pow = new Float64Array(n)
  const SUB = 4
  for (const e of world) {
    if (e.t >= len) break
    const re = e.t + e.dur
    const b0 = Math.max(0, Math.floor(e.t * ENVELOPE_RATE))
    const b1 = Math.min(n - 1, Math.floor(re * ENVELOPE_RATE))
    for (let b = b0; b <= b1; b++) {
      let acc = 0
      for (let s = 0; s < SUB; s++) {
        const tr = (b + (s + 0.5) / SUB) / ENVELOPE_RATE
        if (tr < e.t || tr >= re) continue
        const v = e.amp * Math.exp(-(tr - e.t) / e.decay)
        acc += v * v
      }
      pow[b] += acc / SUB
    }
  }
  const r = rng(seed)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const nz = floor * (0.7 + 0.6 * r())
    out[i] = Math.sqrt(pow[i] + nz * nz)
  }
  return out
}

/** syncWorker.matchPair の粗い合わせ(丸ごと → 2分の窓 → 1分の窓)で「確か」とされるか */
function reliableCoarse(ea: Float32Array, eb: Float32Array): string | null {
  const m = matchFeatures(ea, eb)
  if (m && isReliableMatch(m))
    return `whole offset=${m.offset.toFixed(2)} conf=${m.confidence.toFixed(0)} dist=${m.distinctness.toFixed(2)}`
  const around = m ? { around: m.offset } : {}
  const d =
    matchWithDrift(ea, eb, around) ??
    matchWithDrift(ea, eb, { ...around, windowSec: 60, maxWindows: 12 })
  return d ? `drift offset=${d.offset.toFixed(2)} conf=${d.confidence.toFixed(0)}` : null
}

function pairOf(i: number, floorA: number, floorB: number): { ea: Float32Array; eb: Float32Array } {
  const bLen = 300 + Math.round(rng(77 + i)() * 1200)
  return {
    ea: onsetFeature(record(sparse(4000, 3 * i + 1), 3600, floorA, i)),
    eb: onsetFeature(record(sparse(4000, 3 * i + 2), bLen, floorB, i + 1000))
  }
}

describe('ほとんど無音の関係のない2本を合わせない', () => {
  // 以前の版で合ってしまった種(どちらの組み合わせでも)
  const seeds = [8, 15, 36, 41, 42, 59]

  it('両方ともほぼ無音(雑音 -100dBFS)', () => {
    const hits = seeds
      .map((i) => {
        const { ea, eb } = pairOf(i, 1e-5, 1e-5)
        return [i, reliableCoarse(ea, eb)] as const
      })
      .filter(([, h]) => h !== null)
    expect(hits).toEqual([])
  })

  it('ふつうの雑音の録音と、ほぼ無音の録音', () => {
    const hits = seeds
      .map((i) => {
        const { ea, eb } = pairOf(i, 0.002, 1e-5)
        return [i, reliableCoarse(ea, eb)] as const
      })
      .filter(([, h]) => h !== null)
    expect(hits).toEqual([])
  })
})

import { BandPass } from '../../src/shared/sync/correlate'

/** 再現できる乱数 */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 音楽・効果音の多い映画の音のようなもの(Tears of Steel の 410〜530 秒の代わり):
 * - 中域の伴奏(400〜2500Hz の雑音。大きさがゆっくり変わり、立ち上がりがはっきりしない)
 * - 低音の太鼓(60〜100Hz。0.3〜0.6 秒おき。立ち上がりの大部分はここ)
 * - まばらな効果音・声(広い帯域の 0.1〜0.4 秒の塊が 1〜4 秒おき)
 * 片方の録音機に低域カットがあると、低音の立ち上がりが伴奏に埋もれ、残りの立ち上がりが少なくなる
 * (種 4・200Hz の低域カットで、帯域を揃えない相関の確からしさが 28.5。実地テストの 27 に近い)
 */
export function movieLike(seconds: number, sampleRate: number, seed: number): Float32Array {
  const r = rng(seed)
  const n = Math.round(seconds * sampleRate)
  const out = new Float32Array(n)
  const pad = new BandPass(sampleRate, [400, 2500])
  const block = Math.round(sampleRate / 10)
  let level = 0.05
  for (let i = 0; i < n; i++) {
    if (i % block === 0) level = Math.min(0.15, Math.max(0.04, level * (0.8 + 0.4 * r())))
    out[i] = level * 3 * pad.step(r() * 2 - 1)
  }
  for (let t = 0.2; t < seconds; t += 0.3 + r() * 0.3) {
    const amp = 0.5 * (0.5 + r())
    const f = 40 + r() * 30
    const k0 = Math.round(t * sampleRate)
    for (let i = 0; i < 0.5 * sampleRate && k0 + i < n; i++) {
      const env = Math.min(1, i / (0.015 * sampleRate)) * Math.exp(-i / sampleRate / 0.2)
      out[k0 + i] += amp * env * Math.sin((2 * Math.PI * f * i) / sampleRate)
    }
  }
  for (let t = 1; t < seconds; t += 1 + r() * 3) {
    const amp = 0.1 * (0.5 + r())
    const k0 = Math.round(t * sampleRate)
    const len = Math.round((0.1 + r() * 0.3) * sampleRate)
    for (let i = 0; i < len && k0 + i < n; i++) out[k0 + i] += amp * (r() * 2 - 1)
  }
  return out
}

/** 2次の高域通過(ffmpeg の `highpass` の既定と同じ 2 極・Q 0.707)。録音機の低域カットの代わり */
export function highpass2(x: Float32Array, freq: number, sampleRate: number): Float32Array {
  const w = (2 * Math.PI * freq) / sampleRate
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  const b0 = (1 + cos) / 2 / a0
  const b1 = -(1 + cos) / a0
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0
  const out = new Float32Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x[i]
    y2 = y1
    y1 = y
    out[i] = y
  }
  return out
}

/** 別の録音機で録ったことにする: 音量を変え、別の雑音を足す */
export function rerecord(x: Float32Array, gain: number, noise: number, seed: number): Float32Array {
  const r = rng(seed)
  return x.map((v) => v * gain + noise * (r() * 2 - 1))
}

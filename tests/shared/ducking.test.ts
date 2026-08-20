import { describe, expect, it } from 'vitest'
import {
  DUCKING,
  DUCKING_KNEE,
  advanceDuckDetector,
  createDuckDetector,
  duckDetectorLevel,
  duckGainForLevel,
  duckingFilterArgs,
  isMainVoiceClip
} from '@shared/ducking'
import { NASTY_NUMBERS, round, seeded } from '../helpers/boundary'

const dB = (lin: number): number => 20 * Math.log10(lin)

describe('duckingFilterArgs — 書き出しへ渡す式', () => {
  it('数字は必ず DUCKING から組み立てる(直書きしない)', () => {
    const s = duckingFilterArgs()
    expect(s).toContain(`threshold=${DUCKING.threshold}`)
    expect(s).toContain(`ratio=${DUCKING.ratio}`)
    expect(s).toContain(`attack=${DUCKING.attackMs}`)
    expect(s).toContain(`release=${DUCKING.releaseMs}`)
    expect(s.startsWith('sidechaincompress=')).toBe(true)
  })
})

describe('isMainVoiceClip — サイドチェインへ渡す枝の見分け', () => {
  it('本編クリップに紐づいた音声だけが「本編の音」', () => {
    expect(isMainVoiceClip({ linkedClipId: 'c1' })).toBe(true)
    expect(isMainVoiceClip({})).toBe(false)
    expect(isMainVoiceClip({ linkedClipId: undefined })).toBe(false)
  })
})

describe('duckGainForLevel — 下がり方の静特性', () => {
  it('しきい値より十分小さい音では下げない', () => {
    expect(duckGainForLevel(0)).toBe(1)
    expect(duckGainForLevel(1e-6)).toBe(1)
    expect(duckGainForLevel(DUCKING.threshold / Math.sqrt(DUCKING_KNEE) / 2)).toBe(1)
  })

  it('しきい値を超えると下がる', () => {
    expect(duckGainForLevel(DUCKING.threshold * 4)).toBeLessThan(1)
    expect(duckGainForLevel(1)).toBeLessThan(duckGainForLevel(DUCKING.threshold * 4))
  })

  it('しきい値より十分上では ratio どおりの傾き(1/8)に漸近する', () => {
    // 入力を 20dB 上げたら、出力は 20/ratio = 2.5dB しか上がらない
    const a = 0.5
    const b = 5 // +20dB
    const outA = dB(a * duckGainForLevel(a))
    const outB = dB(b * duckGainForLevel(b))
    expect(outB - outA).toBeCloseTo(20 / DUCKING.ratio, 1)
  })

  it('【不変条件】戻り値は必ず 0〜1 の有限値で、単調に減る', () => {
    let prev = 1
    for (let x = 0; x <= 4; x += 0.001) {
      const g = duckGainForLevel(x)
      expect(Number.isFinite(g), `level=${x} -> ${g}`).toBe(true)
      expect(g).toBeGreaterThan(0)
      expect(g).toBeLessThanOrEqual(1)
      expect(g).toBeLessThanOrEqual(prev + 1e-12)
      prev = g
    }
  })

  it('異常な入力では下げない(黙って音を消さない)', () => {
    for (const v of [NaN, Infinity, -Infinity, -1, -0.5]) {
      expect(duckGainForLevel(v), String(v)).toBe(1)
    }
  })
})

describe('検出器 — 追従の向きと速さ', () => {
  const feed = (
    state: ReturnType<typeof createDuckDetector>,
    amplitude: number,
    seconds: number,
    sampleRate = 48000
  ): void => {
    const n = Math.round(sampleRate * seconds)
    const powers = new Float32Array(n).fill(amplitude * amplitude)
    advanceDuckDetector(state, powers, n, sampleRate)
  }

  it('無音のままなら 0', () => {
    const s = createDuckDetector()
    feed(s, 0, 1)
    expect(duckDetectorLevel(s)).toBe(0)
  })

  it('一定の音を十分な時間入れると、その振幅へ収束する', () => {
    const s = createDuckDetector()
    feed(s, 0.5, 2)
    expect(duckDetectorLevel(s)).toBeCloseTo(0.5, 2)
  })

  it('立ち上がりは attack、立ち下がりは release で**非対称**', () => {
    const up = createDuckDetector()
    feed(up, 1, DUCKING.attackMs / 1000)
    const afterAttack = duckDetectorLevel(up)

    const down = createDuckDetector()
    feed(down, 1, 2)
    feed(down, 0, DUCKING.releaseMs / 1000)
    const afterRelease = duckDetectorLevel(down)

    // attack のほうが速い＝1時定数で立ち上がるほうが、落ちる残量より進む
    expect(afterAttack).toBeGreaterThan(0.5)
    expect(afterRelease).toBeGreaterThan(0)
    expect(afterRelease).toBeLessThan(1)
    expect(DUCKING.attackMs).toBeLessThan(DUCKING.releaseMs)
  })

  it('【不変条件】どんな入力でも level は有限で 0 以上', () => {
    const rnd = seeded(2468)
    const s = createDuckDetector()
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rnd() * 512)
      const powers = new Float32Array(n)
      for (let k = 0; k < n; k++) {
        const r = rnd()
        powers[k] = r < 0.02 ? NaN : r < 0.04 ? Infinity : rnd() * 4
      }
      advanceDuckDetector(s, powers, n, 48000)
      const lv = duckDetectorLevel(s)
      expect(Number.isNaN(lv), `i=${i}`).toBe(false)
      expect(lv).toBeGreaterThanOrEqual(0)
    }
  })

  it('サンプル数 0・サンプルレート 0 でも落ちない', () => {
    const s = createDuckDetector()
    expect(() => advanceDuckDetector(s, new Float32Array(0), 0, 48000)).not.toThrow()
    expect(() => advanceDuckDetector(s, new Float32Array(4), 4, 0)).not.toThrow()
    for (const bad of NASTY_NUMBERS) {
      expect(() => advanceDuckDetector(s, new Float32Array(4), 4, bad)).not.toThrow()
    }
    expect(Number.isNaN(duckDetectorLevel(s))).toBe(false)
  })
})

describe('【レグレッション】画面と書き出しの下がり幅', () => {
  /**
   * 2026-09-03 のバグ狩り。画面の検出器を `sidechaincompress` と同じ
   * 非対称追従＋knee 付き静特性に作り直し、実機の倍率 -16.81dB /
   * 書き出し(raw) -16.79dB まで一致させた(修正前は画面 -14.87dB で約2dBの食い違い)。
   * ここでは「静特性の形」だけを固定する——実際の音での一致は BUGHUNT の記録が担う。
   */
  it('knee の中心(しきい値ちょうど)で、傾きの半分だけ下がっている', () => {
    const g = duckGainForLevel(DUCKING.threshold)
    expect(g).toBeLessThan(1)
    expect(g).toBeGreaterThan(1 / DUCKING.ratio)
  })

  it('knee の幅は DUCKING_KNEE 倍で、その外では折れ線に戻る', () => {
    const lo = DUCKING.threshold / Math.sqrt(DUCKING_KNEE)
    const hi = DUCKING.threshold * Math.sqrt(DUCKING_KNEE)
    expect(duckGainForLevel(lo)).toBe(1)
    // knee を抜けた直後は、折れ線(ratio で潰した値)とほぼ一致する
    const straight = (level: number): number => {
      const over = dB(level) - dB(DUCKING.threshold)
      return 10 ** ((dB(level) - over * (1 - 1 / DUCKING.ratio) - dB(level)) / 20)
    }
    expect(round(duckGainForLevel(hi), 3)).toBe(round(straight(hi), 3))
  })
})

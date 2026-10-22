import { describe, expect, it } from 'vitest'
import {
  WAVE_BASE_RATE,
  WaveBaseBuilder,
  WavePeakAccumulator,
  aggregateBase,
  applyChannelPick,
  baseIsFineEnough,
  decideChannelPick,
  decodeWaveBase,
  tilePick,
  encodeWaveBase,
  waveBaseBytes
} from '@shared/waveformPeaks'

const RATE = 16000

function stereo(seconds: number, l: (t: number) => number, r: (t: number) => number): Float32Array {
  const n = Math.round(seconds * RATE)
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    out[i * 2] = l(i / RATE)
    out[i * 2 + 1] = r(i / RATE)
  }
  return out
}

describe('素の値(WaveBaseBuilder)', () => {
  it('1 秒 100 列。正弦波の最大・最小・RMS が列ごとに入る', () => {
    const b = new WaveBaseBuilder(RATE, 2)
    b.push(
      stereo(
        2,
        (t) => 0.5 * Math.sin(2 * Math.PI * 300 * t),
        (t) => 0.2 * Math.sin(2 * Math.PI * 500 * t)
      )
    )
    const base = b.finish()
    expect(base.rate).toBe(WAVE_BASE_RATE)
    expect(base.columns).toBe(200)
    expect(base.pick).toBe('both')
    const p = aggregateBase(base, 0, 2, 20)
    expect(p.channels).toHaveLength(2)
    for (let k = 0; k < 20; k++) {
      expect(p.channels[0].max[k]).toBeCloseTo(0.5, 2)
      expect(p.channels[0].min[k]).toBeCloseTo(-0.5, 2)
      expect(p.channels[0].rms[k]).toBeCloseTo(0.5 / Math.SQRT2, 2)
      expect(p.channels[1].max[k]).toBeCloseTo(0.2, 2)
    }
  })

  it('モノラル(1ch で読んだ音)は 1 段。-3dB にならない', () => {
    const b = new WaveBaseBuilder(RATE, 1)
    const n = RATE
    const s = new Float32Array(n)
    for (let i = 0; i < n; i++) s[i] = 0.8 * Math.sin((2 * Math.PI * 200 * i) / RATE)
    b.push(s)
    const base = b.finish()
    expect(base.pick).toBe(0)
    const p = aggregateBase(base, 0, 1, 10)
    expect(p.channels).toHaveLength(1)
    expect(p.channels[0].max[3]).toBeCloseTo(0.8, 2)
  })

  it('左右が同じ・右がほぼ無音なら 1 段、左がほぼ無音なら右の 1 段', () => {
    const sine = (t: number): number => 0.4 * Math.sin(2 * Math.PI * 220 * t)
    const same = new WaveBaseBuilder(RATE, 2)
    same.push(stereo(1, sine, sine))
    expect(same.finish().pick).toBe(0)
    const rightSilent = new WaveBaseBuilder(RATE, 2)
    rightSilent.push(stereo(1, sine, () => 0.0001))
    expect(rightSilent.finish().pick).toBe(0)
    const leftSilent = new WaveBaseBuilder(RATE, 2)
    leftSilent.push(stereo(1, () => 0, sine))
    const ls = leftSilent.finish()
    expect(ls.pick).toBe(1)
    expect(aggregateBase(ls, 0, 1, 4).channels[0].max[0]).toBeCloseTo(0.4, 2)
    expect(decideChannelPick(2, 1, 1, 0.5)).toBe('both')
    expect(decideChannelPick(2, 0, 0, 0)).toBe(0)
  })

  it('素の値から集計した値は、同じ音を直接集計した値とほぼ同じ(上下非対称のまま)', () => {
    const l = (t: number): number => Math.max(-0.1, 0.7 * Math.sin(2 * Math.PI * 3 * t))
    const r = (t: number): number => 0.3 * Math.sin(2 * Math.PI * 40 * t)
    const sound = stereo(3, l, r)
    const b = new WaveBaseBuilder(RATE, 2)
    b.push(sound)
    const fromBase = aggregateBase(b.finish(), 0.5, 2.5, 50)
    const direct = new WavePeakAccumulator(50, 2, 2 * RATE)
    direct.push(sound.subarray(0.5 * RATE * 2, 2.5 * RATE * 2))
    const want = direct.finish()
    for (let k = 0; k < 50; k++) {
      expect(fromBase.channels[0].max[k]).toBeCloseTo(want.channels[0].max[k], 2)
      expect(fromBase.channels[0].min[k]).toBeCloseTo(want.channels[0].min[k], 2)
      expect(fromBase.channels[1].rms[k]).toBeCloseTo(want.channels[1].rms[k], 1)
    }
    // 片側だけの振れ(最小は -0.1 まで)
    expect(Math.min(...fromBase.channels[0].min)).toBeGreaterThan(-0.11)
  })

  it('素材の終わりより後は無音で埋まる', () => {
    const b = new WaveBaseBuilder(RATE, 1)
    b.push(new Float32Array(RATE).fill(0.5))
    const p = aggregateBase(b.finish(), 0, 2, 4)
    expect(p.channels[0].max[0]).toBeCloseTo(0.5, 3)
    expect(p.channels[0].max[3]).toBe(0)
  })

  it('チャンクの境目でフレームが割れても同じ結果', () => {
    const sound = stereo(
      1.3,
      (t) => Math.sin(t * 900),
      (t) => 0.2 * Math.cos(t * 333)
    )
    const a = new WaveBaseBuilder(RATE, 2)
    a.push(sound)
    const b = new WaveBaseBuilder(RATE, 2)
    for (let i = 0; i < sound.length; i += 1001) b.push(sound.subarray(i, i + 1001))
    expect(b.finish()).toEqual(a.finish())
  })

  it('ディスクの形: 書いて読むと同じ。壊れた・版の違うものは null', () => {
    const b = new WaveBaseBuilder(RATE, 2)
    b.push(
      stereo(
        0.5,
        (t) => Math.sin(t * 100),
        (t) => Math.cos(t * 70)
      )
    )
    const base = b.finish()
    const bytes = encodeWaveBase(base)
    const back = decodeWaveBase(bytes)
    expect(back).toEqual(base)
    expect(decodeWaveBase(bytes.slice(0, bytes.length - 2))).toBeNull()
    const wrong = bytes.slice()
    wrong[4] = 99
    expect(decodeWaveBase(wrong)).toBeNull()
    expect(decodeWaveBase(new Uint8Array(3))).toBeNull()
    // 頭の細かさ(rate)が今の決まりと違う・0 なら使わない(割り算が狂う)
    for (const rate of [0, 50]) {
      const bad = bytes.slice()
      new DataView(bad.buffer).setUint32(8, rate, true)
      expect(decodeWaveBase(bad)).toBeNull()
    }
  })

  it('大きさの見積もり: 3 時間・ステレオで約 13MB', () => {
    const columns = 3 * 3600 * WAVE_BASE_RATE
    const bytes = waveBaseBytes({
      rate: WAVE_BASE_RATE,
      sourceChannels: 2,
      pick: 'both',
      columns,
      data: new Int16Array(columns * 2 * 3)
    })
    expect(bytes / 1024 / 1024).toBeLessThan(13)
  })

  it('素の値で足りるのは 1 秒 100 列まで(拡大 125% 超は読み直す)', () => {
    expect(baseIsFineEnough(0, 10, 1000)).toBe(true)
    expect(baseIsFineEnough(0, 10, 1001)).toBe(false)
    // 100% (40px/秒 × 2 列 = 80 列/秒) は素の値で足りる
    expect(baseIsFineEnough(0, 3 * 3600, 3 * 3600 * 80)).toBe(true)
  })

  it('読み直した L/R の値を、素の値と同じ 1 段 / 2 段にそろえる', () => {
    const acc = new WavePeakAccumulator(2, 2, 2)
    acc.push(new Float32Array([0.1, 0.9, 0.2, 0.8]))
    const p = acc.finish()
    expect(applyChannelPick(p, 'both').channels).toHaveLength(2)
    expect(applyChannelPick(p, 1).channels[0].max[0]).toBeCloseTo(0.9)
  })

  it('タイルの値だけで決めるときは、左右が同じ・片側が完全な無音のときだけ 1 段', () => {
    const quietL = (t: number): number => 0.035 * Math.sin(2 * Math.PI * 220 * t)
    let seed = 1
    const hiss = (): number => {
      seed = (seed * 16807) % 2147483647
      return (seed / 2147483647 - 0.5) * 0.006
    }
    const acc = (l: (t: number) => number, r: (t: number) => number): WavePeakAccumulator => {
      const a = new WavePeakAccumulator(64, 2, RATE)
      a.push(stereo(1, l, r))
      return a
    }
    // L が静かな話し声・R が弱いノイズ: 2 段のまま(静かな所だけ 1 段/2 段が入れ替わらない)
    expect(tilePick(acc(quietL, hiss).finish())).toBe('both')
    expect(tilePick(acc((t) => 10 * quietL(t), hiss).finish())).toBe('both')
    // 右が完全な無音・左右が同じ・左が完全な無音
    expect(tilePick(acc(quietL, () => 0).finish())).toBe(0)
    expect(tilePick(acc(quietL, quietL).finish())).toBe(0)
    expect(tilePick(acc(() => 0, quietL).finish())).toBe(1)
  })
})

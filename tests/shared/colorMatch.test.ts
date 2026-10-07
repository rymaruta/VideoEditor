import { describe, expect, it } from 'vitest'
import {
  GAIN_LIMIT,
  RgbHistogram,
  applyColorMatch,
  colorMatchFilter,
  describeColorMatch,
  fitColorMatch
} from '../../src/shared/color/match'
import { pairedSamples } from '../../src/shared/color/samples'
import type { MulticamInfo } from '../../src/shared/sync/multicam'

/** 決まった並びの画素(なだらかな分布) */
function frame(transform: (v: number, c: number) => number, n = 20000): Uint8Array {
  const out = new Uint8Array(n * 3)
  let seed = 7
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    const base = 0.1 + 0.8 * (seed / 2 ** 31)
    for (let c = 0; c < 3; c++)
      out[i * 3 + c] = Math.round(255 * Math.min(1, Math.max(0, transform(base, c))))
  }
  return out
}

function hist(f: Uint8Array): RgbHistogram {
  const h = new RgbHistogram()
  h.add(f)
  return h
}

describe('fitColorMatch', () => {
  it('暗く青いカメラを、基準の色へ戻す補正を求める', () => {
    const ref = frame((v) => v)
    // R・G は暗く、B は持ち上がっている(色温度の違い)
    const cam = frame((v, c) => (c === 2 ? v * 0.9 + 0.08 : v * 0.85))
    const m = fitColorMatch(hist(cam), hist(ref))!
    expect(m).not.toBeNull()
    expect(m.gain[0]).toBeCloseTo(1 / 0.85, 1)
    expect(m.gain[2]).toBeCloseTo(1 / 0.9, 1)
    expect(m.offset[2]).toBeCloseTo(-0.08 / 0.9, 1)
    // 中間の灰色が基準の灰色に戻る
    const [r, g, b] = applyColorMatch(m, [0.5 * 0.85, 0.5 * 0.85, 0.5 * 0.9 + 0.08])
    expect(r).toBeCloseTo(0.5, 1)
    expect(g).toBeCloseTo(0.5, 1)
    expect(b).toBeCloseTo(0.5, 1)
    expect(describeColorMatch(m)).toContain('明るさ +')
  })

  it('差が無ければ補正しない', () => {
    const f = frame((v) => v)
    expect(fitColorMatch(hist(f), hist(f))).toBeNull()
  })

  it('大きすぎる差は上限までにとどめる', () => {
    const ref = frame((v) => v)
    const dark = frame((v) => v * 0.3)
    const m = fitColorMatch(hist(dark), hist(ref))!
    for (const g of m.gain) expect(g).toBeLessThanOrEqual(GAIN_LIMIT[1])
  })

  it('ほぼ単色の画どうしは比べない(色の違いが読めない)', () => {
    const flatA = frame(() => 0.5)
    const flatB = frame(() => 0.3)
    expect(fitColorMatch(hist(flatB), hist(flatA))).toBeNull()
  })

  it('合わせても分布の形が違うもの(映っている物の違い)は合わせない', () => {
    const ref = frame((v) => v)
    // 暗部だけが極端に持ち上がった、形の違う分布
    const other = frame((v) => (v < 0.5 ? 0.45 + v * 0.1 : v))
    expect(fitColorMatch(hist(other), hist(ref))).toBeNull()
  })

  it('画素が少なすぎれば比べない', () => {
    expect(fitColorMatch(hist(frame((v) => v, 10)), hist(frame((v) => v)))).toBeNull()
  })
})

describe('colorMatchFilter', () => {
  it('ffmpeg の lutrgb の式(倍率と足し込み。値の範囲はビット深度によらず minval〜maxval)', () => {
    const f = colorMatchFilter({ gain: [1.1, 1, 0.9], offset: [0, 0.02, -0.01] })
    expect(f).toBe(
      "lutrgb=r='clip(val*1.1+0*maxval\\,minval\\,maxval)':g='clip(val*1+0.02*maxval\\,minval\\,maxval)':b='clip(val*0.9+-0.01*maxval\\,minval\\,maxval)'"
    )
  })
})

describe('pairedSamples', () => {
  const info: MulticamInfo = {
    anchorSourceId: 'A',
    sources: [
      { id: 'A', name: 'カメラA', kind: 'camera' },
      { id: 'B', name: 'カメラB', kind: 'camera' }
    ],
    files: [
      { assetId: 'a1', sourceId: 'A', start: 0, rate: 1, duration: 100 },
      { assetId: 'b1', sourceId: 'B', start: 50, rate: 1, duration: 100 }
    ]
  }

  it('両方が録っている時間(50〜100秒)から等間隔に取り、それぞれの素材の時刻を返す', () => {
    const s = pairedSamples(info, 'B', 5)
    expect(s.map((x) => x.time)).toEqual([55, 65, 75, 85, 95])
    expect(s[0].sourceTime).toBe(5)
    expect(s[0].anchorTime).toBe(55)
    expect(s[0].anchorFile.assetId).toBe('a1')
  })

  it('重なりが無ければ取らない', () => {
    const apart: MulticamInfo = {
      ...info,
      files: [info.files[0], { ...info.files[1], start: 200 }]
    }
    expect(pairedSamples(apart, 'B')).toEqual([])
  })
})

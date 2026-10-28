import { describe, expect, it } from 'vitest'
import {
  CANVAS_MAX_SIDE,
  PEAK_REACH,
  WAVEFORM_TILE_WIDTH,
  columnLevels,
  liftLevels,
  liftAmplitude,
  mergedColumn,
  WAVEFORM_AMP_SHARE,
  WAVEFORM_HEIGHT_SCALE,
  WAVEFORM_SPLIT_MIN_HEIGHT,
  peakColumnSpan,
  peakEnvelope,
  waveformDensity,
  tileReadRange,
  waveformTiles
} from '@renderer/lib/waveformTiles'

/** 列ごとの塗りの高さ(中心から上下対称)を持つ、幅 w・高さ h の RGBA */
function picture(w: number, h: number, half: number[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  const center = (h - 1) / 2
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (half[x] > 0 && Math.abs(y - center) <= half[x]) data[(y * w + x) * 4 + 3] = 255
    }
  }
  return data
}

describe('波形のタイル', () => {
  it('どんなに長いクリップでも、1 枚が canvas の上限(65,535px)を超えない', () => {
    // 拡大率 1(40px/秒)で 27 分を超えると 1 枚の canvas では何も描かれなかった
    for (const total of [1, 400, 2048, 2049, 64000, 65535, 65536, 72000, 400000]) {
      const tiles = waveformTiles(total)
      expect(tiles.every((t) => t.w > 0 && t.w <= WAVEFORM_TILE_WIDTH)).toBe(true)
      expect(tiles.every((t) => t.w <= CANVAS_MAX_SIDE)).toBe(true)
      // すき間も重なりも無く、全幅を覆う
      let x = 0
      for (const t of tiles) {
        expect(t.x).toBe(x)
        x += t.w
      }
      expect(x).toBe(total)
    }
  })

  it('幅 0 や負の幅ではタイルを作らない。上限より広いタイル幅を頼まれても上限で切る', () => {
    expect(waveformTiles(0)).toEqual([])
    expect(waveformTiles(-5)).toEqual([])
    const tiles = waveformTiles(200000, 100000)
    expect(Math.max(...tiles.map((t) => t.w))).toBeLessThanOrEqual(CANVAS_MAX_SIDE)
  })

  it('読む範囲は左右に山の広がりぶんはみ出し、絵の端では切る', () => {
    const total = 5000
    const [first, second, last] = [
      { x: 0, w: 2048 },
      { x: 2048, w: 2048 },
      { x: 4096, w: 904 }
    ]
    expect(tileReadRange(first, total)).toEqual({ sx: 0, sw: 2048 + PEAK_REACH, offset: 0 })
    expect(tileReadRange(second, total)).toEqual({
      sx: 2048 - PEAK_REACH,
      sw: 2048 + 2 * PEAK_REACH,
      offset: PEAK_REACH
    })
    expect(tileReadRange(last, total)).toEqual({
      sx: 4096 - PEAK_REACH,
      sw: 904 + PEAK_REACH,
      offset: PEAK_REACH
    })
  })
})

describe('列ごとの大きさと山', () => {
  it('塗りの上下の端から、中心からの高さを読む。塗りの無い列は 0', () => {
    const w = 4
    const h = 11
    const levels = columnLevels(picture(w, h, [0, 1, 3, 5]), w, h)
    expect(Array.from(levels)).toEqual([0, 1.5, 3.5, 5.5])
  })

  it('外側の山はとなりの列までしか広げない(音の出始め・終わりが太って時刻がずれて見えない)', () => {
    const levels = new Float32Array([0, 0, 0, 4, 0, 0, 0])
    const peak = peakEnvelope(levels)
    expect(PEAK_REACH).toBeLessThanOrEqual(2)
    expect(Array.from(peak)).toEqual([0, 0, 4, 4, 4, 0, 0])
    // 平均を下回らない
    expect(Array.from(peak).every((p, i) => p >= levels[i])).toBe(true)
  })

  it('タイルに分けて読んでも、1 枚で読んだときと同じ山になる(境目で欠けない)', () => {
    const total = 50
    const h = 9
    const half = Array.from({ length: total }, (_, i) => (i * 7) % 5)
    const whole = peakEnvelope(columnLevels(picture(total, h, half), total, h))
    const pieced: number[] = []
    for (const tile of waveformTiles(total, 16)) {
      const { sx, sw, offset } = tileReadRange(tile, total)
      const slice = half.slice(sx, sx + sw)
      const peak = peakEnvelope(columnLevels(picture(sw, h, slice), sw, h))
      pieced.push(...Array.from(peak.slice(offset, offset + tile.w)))
    }
    expect(pieced).toEqual(Array.from(whole))
  })
})

describe('細かい波形(Graphite 3)', () => {
  it('指数 0.75 で少し持ち上げる: 小さい音は少し大きく、満ちた音と無音はそのまま', () => {
    const out = liftLevels(new Float32Array([0, 2.5, 10, 20]), 10)
    expect(out[0]).toBe(0)
    expect(out[1]).toBeCloseTo(10 * 0.25 ** 0.75) // 3.54(平方根の 5 ほど持ち上げない)
    expect(out[1]).toBeGreaterThan(2.5)
    expect(out[2]).toBe(10)
    expect(out[3]).toBe(10)
  })
  it('1px に 2 列で頼む。canvas の上限を超える長さは 1 列に戻す', () => {
    expect(waveformDensity(1000)).toBe(2)
    expect(waveformDensity(CANVAS_MAX_SIDE)).toBe(1)
  })
})

describe('値で描く細かい波形の 1 列(peakColumnSpan)', () => {
  it('上下非対称の山をそのまま、振幅は指数 0.75 で少し持ち上げる', () => {
    const s = peakColumnSpan(0.25, -0.04, 0.1, 50, 40)
    expect(s.top).toBeCloseTo(50 - 0.25 ** 0.75 * 40)
    expect(s.bottom).toBeCloseTo(50 + 0.04 ** 0.75 * 40)
    expect(liftAmplitude(-0.25)).toBeCloseTo(-(0.25 ** 0.75))
  })
  it('RMS は山の範囲からはみ出さない(片側だけの音で、無い側に描かない)', () => {
    const s = peakColumnSpan(0.64, 0, 0.36, 50, 40)
    expect(s.bottom).toBe(50)
    expect(s.rmsTop).toBeCloseTo(50 - 0.36 ** 0.75 * 40)
    expect(s.rmsBottom).toBe(50)
  })
  it('低いレーンの 1 本: L と R の外側の山、RMS は二乗平均', () => {
    const ch = (
      max: number,
      min: number,
      rms: number
    ): { max: number[]; min: number[]; rms: number[] } => ({
      max: [max],
      min: [min],
      rms: [rms]
    })
    const v = mergedColumn([ch(0.5, -0.1, 0.3), ch(0.2, -0.6, 0.4)], 0)
    expect(v.max).toBe(0.5)
    expect(v.min).toBe(-0.6)
    expect(v.rms).toBeCloseTo(Math.sqrt((0.09 + 0.16) / 2))
    expect(mergedColumn([ch(0.3, -0.2, 0.1)], 0)).toEqual({ max: 0.3, min: -0.2, rms: 0.1 })
  })
  it('振幅 1 でもレーンの高さの 80% まで・48px 未満は 1 本・縦は倍にしない', () => {
    expect(WAVEFORM_AMP_SHARE).toBe(0.8)
    expect(WAVEFORM_SPLIT_MIN_HEIGHT).toBe(48)
    expect(WAVEFORM_HEIGHT_SCALE).toBe(1)
  })
  it('無音は高さ 0', () => {
    const s = peakColumnSpan(0, 0, 0, 50, 40)
    expect(s.bottom - s.top).toBe(0)
    expect(s.rmsBottom - s.rmsTop).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import {
  CANVAS_MAX_SIDE,
  PEAK_REACH,
  WAVEFORM_TILE_WIDTH,
  columnLevels,
  peakEnvelope,
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

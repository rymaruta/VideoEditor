import { describe, expect, it } from 'vitest'
import { fitZoomFor } from '../../src/renderer/src/lib/timelineMath'

describe('fitZoomFor — タイムライン全体を表示', () => {
  it('3時間の回も 1,384px のレーンに収まる', () => {
    const zoom = fitZoomFor(10800, 1384, 40, 4)
    expect(zoom * 40 * 10800).toBeLessThanOrEqual(1384 + 1e-6)
  })
  it('短い回は上限で止める・壊れた値でも有限', () => {
    expect(fitZoomFor(1, 1384, 40, 4)).toBe(4)
    expect(Number.isFinite(fitZoomFor(0, 1384, 40, 4))).toBe(true)
  })
})

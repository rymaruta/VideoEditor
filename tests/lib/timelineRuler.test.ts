import { describe, expect, it } from 'vitest'
import { formatTimecode, rulerStep, rulerTicks } from '@renderer/lib/timelineRuler'
import { NASTY_NUMBERS } from '../helpers/boundary'

describe('timelineRuler — 時間目盛り', () => {
  it('時:分:秒:フレーム', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00')
    expect(formatTimecode(1374.4667, 30)).toBe('00:22:54:14')
    expect(formatTimecode(3600, 30)).toBe('01:00:00:00')
    expect(formatTimecode(1 / 30, 30)).toBe('00:00:00:01')
    for (const v of NASTY_NUMBERS)
      expect(formatTimecode(v, 30)).toMatch(/^\d{2}:\d{2}:\d{2}:\d{2}$/)
    expect(formatTimecode(Number.MAX_VALUE, 30)).toBe('99:00:00:00')
  })

  it('間隔は数字が重ならない最小のもの', () => {
    expect(rulerStep(40, 30)).toBe(5) // 40px/秒 → 5秒で 200px(2秒だと 80px で足りない)
    expect(rulerStep(1000, 30)).toBeCloseTo(1 / 6) // 5フレーム = 167px(1フレームでは 33px で足りない)
    expect(rulerStep(0.01, 30)).toBe(3600)
    expect(rulerStep(0, 30)).toBe(3600)
  })

  it('見えている範囲の目盛りだけ・間隔の整数倍', () => {
    expect(rulerTicks(12, 31, 5)).toEqual([15, 20, 25, 30])
    expect(rulerTicks(-10, 4, 2)).toEqual([0, 2, 4])
    expect(rulerTicks(0, 1e9, 1)).toHaveLength(400)
    expect(rulerTicks(5, 1, 1)).toEqual([])
    expect(rulerTicks(0, 10, 0)).toEqual([])
  })
})

describe('formatTimecode — 29.97 / 59.94 はドロップフレーム', () => {
  const ntsc = 30000 / 1001
  const at = (frame: number, fps = ntsc): string => formatTimecode(frame / fps, fps)

  it('1コマずつ進めたとき番号が飛ばない(毎分の頭の 2 コマだけ飛ばす)', () => {
    expect(at(499)).toBe('00:00:16;19')
    expect(at(500)).toBe('00:00:16;20')
    expect(at(1799)).toBe('00:00:59;29')
    expect(at(1800)).toBe('00:01:00;02')
  })

  it('10 分ちょうどは 00:10:00;00(実時間とずれない)', () => {
    expect(at(17982)).toBe('00:10:00;00')
    expect(at(17982 * 6)).toBe('01:00:00;00')
    expect(at(35964, 60000 / 1001)).toBe('00:10:00;00')
  })

  it('整数のフレームレートは今までどおり', () => {
    expect(formatTimecode(61.5, 30)).toBe('00:01:01:15')
    expect(formatTimecode(1, 25)).toBe('00:00:01:00')
  })
})

import { describe, expect, it } from 'vitest'
import {
  BAR_FALL_DB_PER_SEC,
  meterFraction,
  meterZone,
  nextBarDb,
  nextPeakHold,
  PEAK_FALL_DB_PER_SEC,
  PEAK_HOLD_MS,
  peakHoldDisplay,
  peakOf,
  toDbfs
} from '@renderer/lib/meterMath'

describe('音量計の計算', () => {
  it('振幅を dBFS に(1 = 0 dBFS、0.5 ≒ −6 dBFS、無音は −∞)', () => {
    expect(toDbfs(1)).toBe(0)
    expect(toDbfs(0.5)).toBeCloseTo(-6.02, 2)
    expect(toDbfs(0)).toBe(-Infinity)
    expect(toDbfs(Number.NaN)).toBe(-Infinity)
  })

  it('目盛りは 0〜−60 dBFS を直線に', () => {
    expect(meterFraction(0)).toBe(1)
    expect(meterFraction(3)).toBe(1)
    expect(meterFraction(-60)).toBe(0)
    expect(meterFraction(-Infinity)).toBe(0)
    expect(meterFraction(-6)).toBeCloseTo(0.9, 6)
    expect(meterFraction(-3)).toBeCloseTo(0.95, 6)
  })

  it('−6 dBFS から黄、−3 dBFS から赤', () => {
    expect(meterZone(-12)).toBe('ok')
    expect(meterZone(-6)).toBe('warn')
    expect(meterZone(-4)).toBe('warn')
    expect(meterZone(-3)).toBe('over')
    expect(meterZone(0.5)).toBe('over')
  })

  it('棒は上がるのはすぐ、下がるのはゆっくり', () => {
    expect(nextBarDb(-30, -10, 16)).toBe(-10)
    expect(nextBarDb(-10, -40, 100)).toBeCloseTo(-10 - BAR_FALL_DB_PER_SEC * 0.1, 6)
    expect(nextBarDb(-59.9, -Infinity, 1000)).toBe(-Infinity)
  })

  it('ピークは留めてから落ちる。超える値が来たら付け直す', () => {
    let hold = nextPeakHold({ db: -Infinity, at: 0 }, -8, 0)
    expect(hold).toEqual({ db: -8, at: 0 })
    hold = nextPeakHold(hold, -20, PEAK_HOLD_MS - 1)
    expect(peakHoldDisplay(hold, PEAK_HOLD_MS - 1)).toBe(-8)
    // 留めた後は一定の速さで落ちる(何度呼んでも二重に落ちない)
    const t = PEAK_HOLD_MS + 500
    hold = nextPeakHold(hold, -40, t)
    hold = nextPeakHold(hold, -40, t)
    expect(peakHoldDisplay(hold, t)).toBeCloseTo(-8 - PEAK_FALL_DB_PER_SEC * 0.5, 6)
    // 落ちてきた高さより大きい値が来たら付け直す
    hold = nextPeakHold(hold, -15, t)
    expect(hold).toEqual({ db: -15, at: t })
    // −60 まで落ちたら消える
    expect(peakHoldDisplay(hold, t + PEAK_HOLD_MS + 10_000)).toBe(-Infinity)
  })

  it('窓の中の最大の振幅', () => {
    expect(peakOf([0, -0.7, 0.3])).toBeCloseTo(0.7, 6)
    expect(peakOf(new Float32Array(4))).toBe(0)
  })
})

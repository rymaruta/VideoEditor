import { beforeEach, describe, expect, it } from 'vitest'
import { overallPercent, resetOverallPercent } from '../../src/renderer/src/lib/busyReporter'

const step = (state: string, percent = 0): { state: string; percent: number } => ({
  state,
  percent
})

describe('自動編集の全体の進み具合', () => {
  beforeEach(() => resetOverallPercent())

  it('終わった工程と動いている工程の進み具合から出す', () => {
    expect(overallPercent([step('done'), step('run', 50), step('wait'), step('wait')])).toBe(37.5)
  })

  it('工程の中で段階が変わって進み具合が 0 に戻っても、後ろへ跳ばない', () => {
    expect(overallPercent([step('done'), step('run', 80)])).toBe(90)
    // 読み込み 80% → 解析 0%
    expect(overallPercent([step('done'), step('run', 0)])).toBe(90)
    // 追い越したらまた進む
    expect(overallPercent([step('done'), step('run', 90)])).toBe(95)
  })

  it('新しい回では前の回の値を引きずらない', () => {
    expect(overallPercent([step('done'), step('done')])).toBe(100)
    resetOverallPercent()
    expect(overallPercent([step('run', 10), step('wait')])).toBe(5)
  })

  it('どの工程も手付かずなら床を外す', () => {
    expect(overallPercent([step('done'), step('run', 50)])).toBe(75)
    expect(overallPercent([step('wait'), step('wait')])).toBe(0)
  })

  it('壊れた進み具合(NaN)は 0 として数える', () => {
    expect(overallPercent([step('run', Number.NaN), step('wait')])).toBe(0)
  })
})

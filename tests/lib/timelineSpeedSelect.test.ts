import { describe, expect, it } from 'vitest'
import { speedLabel, speedSelectChoices } from '@renderer/lib/timelineMath'

describe('速さの選択欄', () => {
  const options = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
  it('時計のずれを直した速さ(1.00005)は 1x と出す', () => {
    expect(speedSelectChoices(1.00005, options).value).toBe(1)
  })
  it('選択肢に無い速さ(1.1)は、その速さを選択肢に足して出す', () => {
    const c = speedSelectChoices(1.1, options)
    expect(c.value).toBe(1.1)
    expect(c.options).toContain(1.1)
  })
})

describe('クリップ名に添える速さ(speedLabel)', () => {
  it('同期で求めた 1 倍との差がごく小さい速さは添えない(全桁の 0.9999999983316958x が出ていた)', () => {
    expect(speedLabel(0.9999999983316958)).toBe('')
    expect(speedLabel(1.00006)).toBe('')
    expect(speedLabel(1)).toBe('')
  })
  it('ほかの速さは小数点以下 3 桁までに丸めて添える(速さそのものは変えない)', () => {
    expect(speedLabel(1.5)).toBe(' (1.5x)')
    expect(speedLabel(0.25)).toBe(' (0.25x)')
    expect(speedLabel(1 / 3)).toBe(' (0.333x)')
    expect(speedLabel(1.004)).toBe(' (1.004x)')
  })
})

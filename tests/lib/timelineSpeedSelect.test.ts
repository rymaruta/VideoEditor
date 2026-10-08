import { describe, expect, it } from 'vitest'
import { speedSelectChoices } from '@renderer/lib/timelineMath'

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

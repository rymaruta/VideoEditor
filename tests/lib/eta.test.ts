import { describe, expect, it } from 'vitest'
import { formatRemaining, remainingMs } from '../../src/renderer/src/lib/eta'

describe('残り時間の目安', () => {
  it('ここまでの進み方から見積もる(始まった直後・進みが小さいうちは出さない)', () => {
    expect(remainingMs(0, 25, 60_000)).toBe(180_000)
    expect(remainingMs(0, 25, 3_000)).toBeNull()
    expect(remainingMs(0, 5, 60_000)).toBeNull()
    expect(remainingMs(undefined, 50, 60_000)).toBeNull()
    expect(remainingMs(0, 100, 60_000)).toBeNull()
  })

  it('分・時間で出す', () => {
    expect(formatRemaining(30_000)).toBe('まもなく')
    expect(formatRemaining(180_000)).toBe('残り約3分')
    expect(formatRemaining(3_900_000)).toBe('残り約1時間5分')
    expect(formatRemaining(7_200_000)).toBe('残り約2時間')
  })
})

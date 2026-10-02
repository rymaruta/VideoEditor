import { describe, expect, it } from 'vitest'
import { clampPage, pageCount, pageForTime, pageSlice } from '@renderer/lib/listPaging'
import { NASTY_NUMBERS } from '../helpers/boundary'

describe('listPaging — 長い一覧のページ送り', () => {
  it('ページ数・範囲', () => {
    expect(pageCount(0, 50)).toBe(1)
    expect(pageCount(50, 50)).toBe(1)
    expect(pageCount(51, 50)).toBe(2)
    expect(pageSlice(0, 120, 50)).toEqual({ start: 0, end: 50 })
    expect(pageSlice(2, 120, 50)).toEqual({ start: 100, end: 120 })
  })

  it('件数が減ってページが無くなったら最後のページへ戻す', () => {
    expect(clampPage(5, 120, 50)).toBe(2)
    expect(clampPage(-1, 120, 50)).toBe(0)
    for (const v of NASTY_NUMBERS) {
      const p = clampPage(v, 120, 50)
      expect(p >= 0 && p <= 2 && Number.isInteger(p)).toBe(true)
    }
  })

  it('再生位置のページ: 出ているもの → 後で最初に出るもの → 最後', () => {
    const items = Array.from({ length: 120 }, (_, i) => ({
      startTime: i * 10,
      endTime: i * 10 + 5
    }))
    expect(pageForTime(items, 512, 50)).toBe(1) // 51番目(510〜515)
    expect(pageForTime(items, 1007, 50)).toBe(2) // 1007 は隙間 → 次の 1010(101番目)
    expect(pageForTime(items, 99999, 50)).toBe(2)
    expect(pageForTime([], 5, 50)).toBe(0)
  })
})

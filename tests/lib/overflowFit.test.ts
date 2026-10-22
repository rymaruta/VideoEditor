import { describe, expect, it } from 'vitest'
import { fitToolbar, fixedWidthOf, itemsThatFit } from '@renderer/lib/overflowFit'

describe('itemsThatFit(1 行の帯に並べる数)', () => {
  it('全部入るなら全部(「その他」は要らない)', () => {
    expect(itemsThatFit(1000, 500, [100, 100, 100], 4, 70)).toBe(3)
  })
  it('入らないときは「その他」の分を空けて、前から入るだけ', () => {
    // 500 + 104 + 104 + (70+4) = 782 ≤ 800、3 つ目は入らない
    expect(itemsThatFit(800, 500, [100, 100, 100], 4, 70)).toBe(2)
  })
  it('回せない物だけで一杯なら 0', () => {
    expect(itemsThatFit(500, 520, [100], 4, 70)).toBe(0)
  })
})

describe('fixedWidthOf', () => {
  it('今並べている回せる物と「その他」を引く', () => {
    expect(fixedWidthOf(900, [100, 100], 4, true, 70)).toBe(900 - 208 - 74)
    expect(fixedWidthOf(900, [], 4, false, 70)).toBe(900)
  })
})

describe('fitToolbar(回す → それでも入らなければ欄を詰める)', () => {
  const base = { gap: 4, moreWidth: 70, items: [80, 90, 100], compactSaving: 60 }
  it('広いときは全部並べ、詰めない', () => {
    expect(fitToolbar({ ...base, available: 2000, contentWidth: 1200, shownNow: 3 })).toEqual({
      shown: 3,
      compact: false
    })
  })
  it('今の並べ方に関係なく同じ答え(並べ直しで揺れない)', () => {
    const all = 600 + 84 + 94 + 104
    const a = fitToolbar({ ...base, available: 800, contentWidth: all, shownNow: 3 })
    // 1 つだけ並べて「その他」が出ている帯
    const b = fitToolbar({ ...base, available: 800, contentWidth: 600 + 84 + 74, shownNow: 1 })
    expect(a).toEqual(b)
    expect(a.shown).toBe(1)
  })
  it('全部回しても入らなければ欄を詰める', () => {
    // 中身の幅は「その他」(74)を含む
    expect(fitToolbar({ ...base, available: 700, contentWidth: 760, shownNow: 0 })).toEqual({
      shown: 0,
      compact: true
    })
  })
  it('全部回せば入るなら、詰めない', () => {
    expect(fitToolbar({ ...base, available: 700, contentWidth: 690, shownNow: 0 })).toEqual({
      shown: 0,
      compact: false
    })
  })
})

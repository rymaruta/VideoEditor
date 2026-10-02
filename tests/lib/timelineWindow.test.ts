import { describe, expect, it } from 'vitest'
import { inWindow, pinnedIds, visibleWindowSeconds } from '@renderer/lib/timelineWindow'
import { NASTY_NUMBERS } from '../helpers/boundary'

describe('timelineWindow — 見えている範囲だけ描く', () => {
  it('左右に1画面ぶんずつ余分を取った範囲(秒)', () => {
    // 40px/秒・幅400px・4000px までスクロール → 見えているのは 100〜110秒、余分込みで 90〜120秒
    expect(visibleWindowSeconds(4000, 400, 40)).toEqual({ from: 90, to: 120 })
  })

  it('幅がまだ測れていない・倍率が壊れているときは全部描く(見えているのに描かれない、を避ける)', () => {
    expect(visibleWindowSeconds(0, 0, 40)).toEqual({ from: -Infinity, to: Infinity })
    expect(visibleWindowSeconds(0, 400, 0)).toEqual({ from: -Infinity, to: Infinity })
    for (const v of NASTY_NUMBERS) {
      const w = visibleWindowSeconds(v, 400, 40)
      expect(Number.isNaN(w.from) || Number.isNaN(w.to)).toBe(false)
    }
  })

  it('端が掛かっていれば描く', () => {
    const w = { from: 90, to: 120 }
    expect(inWindow(w, 80, 90)).toBe(true)
    expect(inWindow(w, 120, 130)).toBe(true)
    expect(inWindow(w, 0, 89.9)).toBe(false)
    expect(inWindow(w, 120.1, 200)).toBe(false)
  })

  it('pinnedIds: 状態の中の ID を形によらず拾う', () => {
    const ids = pinnedIds([
      'clip-a',
      ['clip-b', 'clip-c'],
      { clipId: 'clip-d', trackId: 't1', live: 3 },
      null,
      undefined,
      { nested: { id: 'deep' } }
    ])
    expect([...ids].sort()).toEqual(['clip-a', 'clip-b', 'clip-c', 'clip-d', 'deep', 't1'])
  })
})

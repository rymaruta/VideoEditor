import { describe, expect, it } from 'vitest'
import { COMPACT, fitByLevels, rowWidth, type FitInput } from '@renderer/lib/overflowFit'

// タイムラインの道具の帯と同じ並び・回す順(幅は 1366 で測った値に近いもの)
const elements = [
  { id: 'left', width: 28 },
  { id: 'right', width: 28 },
  { id: 'trim', width: 58 },
  { id: 'cut', width: 77 },
  { id: 'silence', width: 96 },
  { id: 'filler', width: 110 },
  { id: 'speed', width: 105, narrowWidth: 64 },
  { id: 'transition', width: 145, narrowWidth: 88 },
  { id: 'copy', width: 28 },
  { id: 'dup', width: 46 },
  { id: 'del', width: 28 }
]
const removal = [
  'filler',
  'silence',
  COMPACT,
  'del',
  'dup',
  'copy',
  'transition',
  'speed',
  'cut',
  'trim',
  'right',
  'left'
]
const input = (available: number): FitInput => ({
  available,
  fixed: 350,
  elements,
  removal,
  gap: 4,
  moreWidth: 76
})

describe('fitByLevels(道具の帯を 1 行に、切り落とさずに)', () => {
  it('広ければ全部並べ、「その他」は出さない', () => {
    expect(fitByLevels(input(2000))).toEqual({ hidden: [], compact: false })
  })
  it('狭くなるにつれ、決めた順に回す(後ろの操作 → 欄を詰める → 削除・複製・コピー → 欄 → …)', () => {
    let prev = -1
    for (let w = 2000; w >= 300; w -= 20) {
      const r = fitByLevels(input(w))
      const level = r.hidden.length + (r.compact ? 1 : 0)
      expect(level).toBeGreaterThanOrEqual(prev)
      prev = level
      // 入る並べ方を選んでいる(全部回しても入らないときだけ例外)
      if (r.hidden.length < elements.length)
        expect(rowWidth(input(w), new Set(r.hidden), r.compact)).toBeLessThanOrEqual(w)
    }
  })
  it('すべての操作に、帯か「その他」から届く(回した物は hidden に、残りは帯に)', () => {
    for (let w = 300; w <= 2000; w += 40) {
      const r = fitByLevels(input(w))
      const shown = elements.filter((e) => !r.hidden.includes(e.id)).map((e) => e.id)
      expect([...shown, ...r.hidden].sort()).toEqual(elements.map((e) => e.id).sort())
    }
  })
  it('右端のまとまり(削除・複製・コピー)は、欄を詰めても入らないときに回す', () => {
    const atCompact = fitByLevels(
      input(350 + 28 * 2 + 58 + 77 + 64 + 88 + 28 + 46 + 28 + 9 * 4 + 80)
    )
    expect(atCompact.compact).toBe(true)
    expect(atCompact.hidden).not.toContain('del')
    const tighter = fitByLevels(input(350 + 28 * 2 + 58 + 77 + 64 + 88 + 8 * 4 + 40))
    expect(tighter.hidden).toEqual(expect.arrayContaining(['del', 'dup', 'copy']))
  })
  it('無い要素の段は飛ばす', () => {
    const r = fitByLevels({ ...input(2000), elements: elements.slice(0, 4) })
    expect(r).toEqual({ hidden: [], compact: false })
  })
})

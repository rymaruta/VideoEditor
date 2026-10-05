import { describe, expect, it } from 'vitest'
import {
  distributeGradient,
  gradientCss,
  gradientSuggestions,
  reverseGradient
} from '../../src/renderer/src/lib/telopAppearance'
import {
  addFavoriteGradient,
  normalizeFavoriteGradients,
  normalizeSectionPresets,
  SECTION_KEYS
} from '../../src/renderer/src/lib/appearancePresets'
import type { TelopGradient } from '@shared/types'

const g: TelopGradient = {
  angle: 0,
  stops: [
    { at: 0, color: '#ff0000' },
    { at: 0.2, color: '#00ff00' },
    { at: 1, color: '#0000ff' }
  ]
}

describe('グラデーションの道具', () => {
  it('反転・等間隔・円形の見本', () => {
    expect(reverseGradient(g).stops.map((s) => [s.at, s.color])).toEqual([
      [0, '#0000ff'],
      [0.8, '#00ff00'],
      [1, '#ff0000']
    ])
    expect(distributeGradient(g).stops.map((s) => s.at)).toEqual([0, 0.5, 1])
    expect(gradientCss({ ...g, type: 'radial' })).toMatch(/^radial-gradient\(circle/)
  })

  it('1つの色から配色を提案する(無彩色は色を足さない・読めない色は空)', () => {
    const list = gradientSuggestions('#e8457a')
    expect(list.map((x) => x.name)).toEqual(['明→暗', '光沢', '類似色', '補色', '3色', '白から'])
    for (const x of list) {
      expect(x.gradient.stops.length).toBeGreaterThanOrEqual(2)
      for (const s of x.gradient.stops) expect(s.color).toMatch(/^#[0-9a-f]{6}$/)
    }
    const gray = gradientSuggestions('#808080')[0].gradient.stops
    for (const s of gray) {
      const n = s.color.slice(1)
      expect(n.slice(0, 2)).toBe(n.slice(2, 4))
      expect(n.slice(2, 4)).toBe(n.slice(4, 6))
    }
    expect(gradientSuggestions('ないいろ')).toEqual([])
  })
})

describe('マイ配色・マイ設定', () => {
  it('同じ配色は二重に保存しない(先頭へ寄せる)。壊れた保存値は捨てる', () => {
    let list = addFavoriteGradient([], g, '虹', 'a')
    list = addFavoriteGradient(list, { ...g, angle: 90 }, '', 'b')
    list = addFavoriteGradient(list, g, '別名', 'c')
    expect(list.map((f) => [f.id, f.name])).toEqual([
      ['a', '虹'],
      ['b', '配色 2']
    ])
    expect(
      normalizeFavoriteGradients([
        { id: 'x', name: 'n', gradient: { angle: 0, stops: [] } },
        list[0]
      ])
    ).toHaveLength(1)
  })

  it('マイ設定は、その項目のキーだけを残して読む', () => {
    const out = normalizeSectionPresets(
      {
        shadow: [
          { id: 'p', name: '濃い影', values: { shadow: true, shadowBlur: 8, color: '#f00' } }
        ],
        nope: []
      },
      (k) => SECTION_KEYS[k]
    )
    expect(Object.keys(out)).toEqual(['shadow'])
    expect(out.shadow[0].values.shadowBlur).toBe(8)
    expect('color' in out.shadow[0].values).toBe(false)
  })
})

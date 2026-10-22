import { describe, expect, it } from 'vitest'
import {
  PRIMARY_PANEL_TABS,
  fitTabs,
  isInMore,
  moveMenuFocus,
  splitPanelTabs,
  storedPanelTab
} from '@renderer/lib/panelTabs'

// App.tsx の上段左のパネル(並びも同じ)
const TABS = [
  { id: 'inspector', label: 'インスペクタ' },
  { id: 'template', label: 'テンプレート' },
  { id: 'text', label: 'テキスト' },
  { id: 'narration', label: 'ボイス' },
  { id: 'thumbnail', label: 'サムネ' },
  { id: 'audio', label: 'BGM/SE' },
  { id: 'preset', label: 'プリセット' },
  { id: 'gametrend', label: 'ゲームトレンド' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'metadata', label: '投稿準備' }
]

describe('splitPanelTabs(よく使うタブを表に、残りは用途ごとに)', () => {
  it('表は 4 つ、残りは 素材づくり / 仕上げ / 投稿 にまとめ、どのタブも消えない', () => {
    const { primary, groups } = splitPanelTabs(TABS)
    expect(primary.map((t) => t.label)).toEqual([
      'インスペクタ',
      'テキスト',
      'BGM/SE',
      'テンプレート'
    ])
    expect(groups.map((g) => [g.label, g.tabs.map((t) => t.label)])).toEqual([
      ['素材づくり', ['ボイス', 'サムネ']],
      ['仕上げ', ['プリセット']],
      ['投稿', ['投稿準備', 'YouTube', 'ゲームトレンド']]
    ])
    const all = [...primary, ...groups.flatMap((g) => g.tabs)].map((t) => t.id).sort()
    expect(all).toEqual(TABS.map((t) => t.id).sort())
  })
  it('まとまりに無い新しいタブは最後のまとまりへ(消さない)', () => {
    const { groups } = splitPanelTabs([...TABS, { id: 'new', label: '新しい' }])
    expect(groups[groups.length - 1].tabs.map((t) => t.id)).toContain('new')
  })
  it('無いタブは並べない(空のまとまりも出さない)', () => {
    const { primary, groups } = splitPanelTabs(
      TABS.filter((t) => t.id !== 'preset' && t.id !== 'audio')
    )
    expect(primary.map((t) => t.id)).toEqual(['inspector', 'text', 'template'])
    expect(groups.map((g) => g.label)).toEqual(['素材づくり', '投稿'])
  })
})

describe('isInMore', () => {
  it('表のタブ・ソース(定義に無い)は「その他」ではない', () => {
    for (const id of PRIMARY_PANEL_TABS) expect(isInMore(id, TABS)).toBe(false)
    expect(isInMore('source', TABS)).toBe(false)
    expect(isInMore('narration', TABS)).toBe(true)
  })
})

describe('storedPanelTab(選んだタブを覚える)', () => {
  it('覚えたタブがあればそれ、無い・知らないタブなら既定', () => {
    expect(storedPanelTab('youtube', TABS, 'inspector')).toBe('youtube')
    expect(storedPanelTab(null, TABS, 'inspector')).toBe('inspector')
    expect(storedPanelTab('source', TABS, 'inspector')).toBe('inspector')
    expect(storedPanelTab('', TABS, 'inspector')).toBe('inspector')
  })
})

describe('moveMenuFocus(「その他」の中の矢印キー)', () => {
  it('上下で巡回し、Home / End で端へ', () => {
    expect(moveMenuFocus('ArrowDown', 0, 6)).toBe(1)
    expect(moveMenuFocus('ArrowDown', 5, 6)).toBe(0)
    expect(moveMenuFocus('ArrowUp', 0, 6)).toBe(5)
    expect(moveMenuFocus('ArrowDown', -1, 6)).toBe(0)
    expect(moveMenuFocus('Home', 3, 6)).toBe(0)
    expect(moveMenuFocus('End', 0, 6)).toBe(5)
    expect(moveMenuFocus('a', 0, 6)).toBeNull()
    expect(moveMenuFocus('ArrowDown', 0, 0)).toBeNull()
  })
})

describe('fitTabs(帯に入るだけ表に並べる)', () => {
  const ids = ['source', 'inspector', 'text', 'audio', 'template', 'gametrend']
  const widths = [50, 80, 60, 60, 80, 100]
  it('全部入るなら全部', () => {
    expect(fitTabs(ids, widths, 1000, 'inspector')).toEqual(ids)
  })
  it('入らない所から後ろは回す。今開いているタブは必ず残す', () => {
    // gametrend(100)を先に取り、残り 200 に source・inspector・text(190)まで
    expect(fitTabs(ids, widths, 300, 'gametrend')).toEqual([
      'source',
      'inspector',
      'text',
      'gametrend'
    ])
  })
  it('今のタブだけで一杯でも、今のタブは見せる', () => {
    expect(fitTabs(ids, widths, 40, 'template')).toEqual(['template'])
  })
  it('今のタブが並びに無いときは前から', () => {
    expect(fitTabs(ids, widths, 200, 'narration')).toEqual(['source', 'inspector', 'text'])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

// 設定のストアは読み込み時に localStorage を読む
vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})

import { parseBulkFontSize } from '@renderer/lib/textOverlayInput'
import { useSettingsStore } from '@renderer/store/settingsStore'

describe('まとめて変えるテロップのサイズ', () => {
  it('0・負のサイズは書き込まない。打ち始めの小さい値は受ける', () => {
    expect(parseBulkFontSize('0')).toBeNull()
    expect(parseBulkFontSize('-2')).toBeNull()
    expect(parseBulkFontSize('3')).toBe(3)
    expect(parseBulkFontSize('48')).toBe(48)
    expect(parseBulkFontSize('  ')).toBeNull()
  })
})

describe('マイ設定を消して元に戻す', () => {
  beforeEach(() => useSettingsStore.setState({ sectionPresets: {} }))

  it('元の id・位置へ戻し、間に保存した同じ名前の設定を上書きしない', () => {
    const s = (): ReturnType<typeof useSettingsStore.getState> => useSettingsStore.getState()
    const glow = (color: string): { glow: { color: string; size: number; opacity: number } } => ({
      glow: { color, size: 4, opacity: 1 }
    })
    s().addSectionPreset('glow', '光A', glow('#ff0000'))
    s().addSectionPreset('glow', '光B', glow('#00ff00'))
    const removed = s().sectionPresets.glow[1]
    s().removeSectionPreset('glow', removed.id)
    s().addSectionPreset('glow', '光A', glow('#0000ff'))
    s().restoreSectionPreset('glow', removed, 1)
    const after = s().sectionPresets.glow
    expect(after.map((p) => p.values.glow?.color)).toEqual(['#0000ff', '#ff0000', '#00ff00'])
    expect(after[1].id).toBe(removed.id)
  })
})

describe('壊れたマイ設定の保存データ', () => {
  it('「toString」などの名前の項目があっても、ほかの項目は読む', async () => {
    const { normalizeSectionPresets, SECTION_KEYS } =
      await import('@renderer/lib/appearancePresets')
    const out = normalizeSectionPresets(
      {
        toString: [{ id: 'a', name: 'b', values: {} }],
        fill: [{ id: 'f', name: '赤', values: { color: '#ff0000' } }]
      },
      (section) => (SECTION_KEYS as Record<string, never>)[section]
    )
    expect(out.fill?.map((p) => p.name)).toEqual(['赤'])
    expect(Object.hasOwn(out, 'toString')).toBe(false)
  })
})

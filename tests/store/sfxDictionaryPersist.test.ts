import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0
  }
})
import { useSfxDictionaryStore } from '@renderer/store/sfxDictionaryStore'

describe('キーワード SE の辞書', () => {
  it('保存できなくても(容量が一杯)、画面の変更は残る', () => {
    useSfxDictionaryStore.getState().addEntry('拍手', '/se/clap.wav', 'clap.wav')
    expect(useSfxDictionaryStore.getState().entries.map((e) => e.keyword)).toEqual(['拍手'])
  })
})

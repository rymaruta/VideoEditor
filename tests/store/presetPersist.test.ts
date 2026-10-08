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
import { usePresetStore } from '@renderer/store/presetStore'

describe('プリセットの保存', () => {
  it('保存できなくても(容量が一杯)、足したプリセットは画面に残る', () => {
    const before = usePresetStore.getState().exportPresets.length
    expect(() =>
      usePresetStore.getState().addExportPreset('web', {
        aspectRatio: '16:9',
        resolutionHeight: 1080,
        quality: 'high'
      } as never)
    ).not.toThrow()
    expect(usePresetStore.getState().exportPresets.length).toBe(before + 1)
  })
})

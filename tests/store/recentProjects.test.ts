import { describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => {
  const store = new Map<string, string>()
  const s = {
    full: false,
    store
  }
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (s.full) throw new DOMException('exceeded the quota', 'QuotaExceededError')
      store.set(k, v)
    },
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
  return s
})
import { useRecentProjectsStore } from '@renderer/store/recentProjectsStore'

describe('最近のプロジェクト', () => {
  it('保存領域が満杯でも投げず、画面の一覧は更新する', () => {
    storage.full = true
    expect(() => useRecentProjectsStore.getState().rememberProject('/x/a.veproj', 1)).not.toThrow()
    expect(useRecentProjectsStore.getState().recentProjects[0].filePath).toBe('/x/a.veproj')
    expect(() => useRecentProjectsStore.getState().forgetProject('/x/a.veproj')).not.toThrow()
    expect(useRecentProjectsStore.getState().recentProjects).toEqual([])
  })
})

import { create } from 'zustand'
import { v4 as uuid } from 'uuid'

const SFX_DICTIONARY_KEY = 've-sfx-dictionary'

export interface SfxDictionaryEntry {
  id: string
  keyword: string
  filePath: string
  fileName: string
  volume: number
}

// presetStore の loadArray と同じ理由: localStorage が配列でない値や壊れた要素を
// 持っていると、それを .map() する画面ごと落ちる。使える要素だけ残す。
function loadEntries(key: string): SfxDictionaryEntry[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is SfxDictionaryEntry => {
      if (typeof e !== 'object' || e === null) return false
      const v = e as Record<string, unknown>
      return (
        typeof v.id === 'string' &&
        typeof v.keyword === 'string' &&
        typeof v.filePath === 'string' &&
        typeof v.fileName === 'string' &&
        typeof v.volume === 'number'
      )
    })
  } catch {
    return []
  }
}

interface SfxDictionaryState {
  entries: SfxDictionaryEntry[]
  addEntry: (keyword: string, filePath: string, fileName: string) => void
  updateEntry: (id: string, patch: Partial<Omit<SfxDictionaryEntry, 'id'>>) => void
  removeEntry: (id: string) => void
}

/**
 * 辞書を保存する。保存できなくても(容量が一杯・使えない)画面の変更は残す
 * (保存の失敗で投げると、変更そのものが消えていた)
 */
function persist(entries: SfxDictionaryEntry[]): void {
  try {
    localStorage.setItem(SFX_DICTIONARY_KEY, JSON.stringify(entries))
  } catch {
    // 次に保存できたときに書かれる
  }
}

export const useSfxDictionaryStore = create<SfxDictionaryState>((set, get) => ({
  entries: loadEntries(SFX_DICTIONARY_KEY),

  addEntry: (keyword, filePath, fileName) => {
    const next = [...get().entries, { id: uuid(), keyword, filePath, fileName, volume: 1 }]
    persist(next)
    set({ entries: next })
  },

  updateEntry: (id, patch) => {
    const next = get().entries.map((e) => (e.id === id ? { ...e, ...patch } : e))
    persist(next)
    set({ entries: next })
  },

  removeEntry: (id) => {
    const next = get().entries.filter((e) => e.id !== id)
    persist(next)
    set({ entries: next })
  }
}))

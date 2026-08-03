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

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

interface SfxDictionaryState {
  entries: SfxDictionaryEntry[]
  addEntry: (keyword: string, filePath: string, fileName: string) => void
  updateEntry: (id: string, patch: Partial<Omit<SfxDictionaryEntry, 'id'>>) => void
  removeEntry: (id: string) => void
}

export const useSfxDictionaryStore = create<SfxDictionaryState>((set, get) => ({
  entries: loadJson(SFX_DICTIONARY_KEY, []),

  addEntry: (keyword, filePath, fileName) => {
    const next = [...get().entries, { id: uuid(), keyword, filePath, fileName, volume: 1 }]
    localStorage.setItem(SFX_DICTIONARY_KEY, JSON.stringify(next))
    set({ entries: next })
  },

  updateEntry: (id, patch) => {
    const next = get().entries.map((e) => (e.id === id ? { ...e, ...patch } : e))
    localStorage.setItem(SFX_DICTIONARY_KEY, JSON.stringify(next))
    set({ entries: next })
  },

  removeEntry: (id) => {
    const next = get().entries.filter((e) => e.id !== id)
    localStorage.setItem(SFX_DICTIONARY_KEY, JSON.stringify(next))
    set({ entries: next })
  }
}))

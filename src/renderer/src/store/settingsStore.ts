import { create } from 'zustand'
import type { KeymapScheme } from '../lib/keymap'

const STORAGE_KEY = 've-youtube-api-key'
const JAMENDO_STORAGE_KEY = 've-jamendo-client-id'
const FREESOUND_STORAGE_KEY = 've-freesound-api-key'
const GEMINI_STORAGE_KEY = 've-gemini-api-key'
const KEYMAP_STORAGE_KEY = 've-keymap-scheme'
const SNAP_ENABLED_KEY = 've-snap-enabled'

interface SettingsState {
  youtubeApiKey: string
  setYoutubeApiKey: (key: string) => void
  jamendoClientId: string
  setJamendoClientId: (key: string) => void
  freesoundApiKey: string
  setFreesoundApiKey: (key: string) => void
  geminiApiKey: string
  setGeminiApiKey: (key: string) => void
  keymapScheme: KeymapScheme
  setKeymapScheme: (scheme: KeymapScheme) => void
  snapEnabled: boolean
  setSnapEnabled: (enabled: boolean) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  youtubeApiKey: localStorage.getItem(STORAGE_KEY) ?? '',
  setYoutubeApiKey: (key) => {
    localStorage.setItem(STORAGE_KEY, key)
    set({ youtubeApiKey: key })
  },
  jamendoClientId: localStorage.getItem(JAMENDO_STORAGE_KEY) ?? '',
  setJamendoClientId: (key) => {
    localStorage.setItem(JAMENDO_STORAGE_KEY, key)
    set({ jamendoClientId: key })
  },
  freesoundApiKey: localStorage.getItem(FREESOUND_STORAGE_KEY) ?? '',
  setFreesoundApiKey: (key) => {
    localStorage.setItem(FREESOUND_STORAGE_KEY, key)
    set({ freesoundApiKey: key })
  },
  geminiApiKey: localStorage.getItem(GEMINI_STORAGE_KEY) ?? '',
  setGeminiApiKey: (key) => {
    localStorage.setItem(GEMINI_STORAGE_KEY, key)
    set({ geminiApiKey: key })
  },
  keymapScheme: (localStorage.getItem(KEYMAP_STORAGE_KEY) as KeymapScheme) ?? 'default',
  setKeymapScheme: (scheme) => {
    localStorage.setItem(KEYMAP_STORAGE_KEY, scheme)
    set({ keymapScheme: scheme })
  },
  snapEnabled: localStorage.getItem(SNAP_ENABLED_KEY) !== 'false',
  setSnapEnabled: (enabled) => {
    localStorage.setItem(SNAP_ENABLED_KEY, String(enabled))
    set({ snapEnabled: enabled })
  }
}))

import { create } from 'zustand'
import type { KeymapScheme } from '../lib/keymap'

const STORAGE_KEY = 've-youtube-api-key'
const JAMENDO_STORAGE_KEY = 've-jamendo-client-id'
const FREESOUND_STORAGE_KEY = 've-freesound-api-key'
const GEMINI_STORAGE_KEY = 've-gemini-api-key'
const KEYMAP_STORAGE_KEY = 've-keymap-scheme'
const SNAP_ENABLED_KEY = 've-snap-enabled'
const SHORTCUT_GUIDE_VISIBLE_KEY = 've-shortcut-guide-visible'

export interface EnvKeySources {
  youtubeApiKey: boolean
  jamendoClientId: boolean
  freesoundApiKey: boolean
  geminiApiKey: boolean
}

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
  shortcutGuideVisible: boolean
  setShortcutGuideVisible: (visible: boolean) => void
  envKeySources: EnvKeySources
  loadEnvApiKeys: () => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  youtubeApiKey: localStorage.getItem(STORAGE_KEY) ?? '',
  setYoutubeApiKey: (key) => {
    localStorage.setItem(STORAGE_KEY, key)
    set((s) => ({
      youtubeApiKey: key,
      envKeySources: { ...s.envKeySources, youtubeApiKey: false }
    }))
  },
  jamendoClientId: localStorage.getItem(JAMENDO_STORAGE_KEY) ?? '',
  setJamendoClientId: (key) => {
    localStorage.setItem(JAMENDO_STORAGE_KEY, key)
    set((s) => ({
      jamendoClientId: key,
      envKeySources: { ...s.envKeySources, jamendoClientId: false }
    }))
  },
  freesoundApiKey: localStorage.getItem(FREESOUND_STORAGE_KEY) ?? '',
  setFreesoundApiKey: (key) => {
    localStorage.setItem(FREESOUND_STORAGE_KEY, key)
    set((s) => ({
      freesoundApiKey: key,
      envKeySources: { ...s.envKeySources, freesoundApiKey: false }
    }))
  },
  geminiApiKey: localStorage.getItem(GEMINI_STORAGE_KEY) ?? '',
  setGeminiApiKey: (key) => {
    localStorage.setItem(GEMINI_STORAGE_KEY, key)
    set((s) => ({ geminiApiKey: key, envKeySources: { ...s.envKeySources, geminiApiKey: false } }))
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
  },
  shortcutGuideVisible: localStorage.getItem(SHORTCUT_GUIDE_VISIBLE_KEY) !== 'false',
  setShortcutGuideVisible: (visible) => {
    localStorage.setItem(SHORTCUT_GUIDE_VISIBLE_KEY, String(visible))
    set({ shortcutGuideVisible: visible })
  },
  envKeySources: {
    youtubeApiKey: false,
    jamendoClientId: false,
    freesoundApiKey: false,
    geminiApiKey: false
  },
  loadEnvApiKeys: async () => {
    try {
      const envKeys = await window.api.getEnvApiKeys()
      set((s) => ({
        youtubeApiKey: envKeys.youtubeApiKey || s.youtubeApiKey,
        jamendoClientId: envKeys.jamendoClientId || s.jamendoClientId,
        freesoundApiKey: envKeys.freesoundApiKey || s.freesoundApiKey,
        geminiApiKey: envKeys.geminiApiKey || s.geminiApiKey,
        envKeySources: {
          youtubeApiKey: Boolean(envKeys.youtubeApiKey),
          jamendoClientId: Boolean(envKeys.jamendoClientId),
          freesoundApiKey: Boolean(envKeys.freesoundApiKey),
          geminiApiKey: Boolean(envKeys.geminiApiKey)
        }
      }))
    } catch {
      // .env is optional; fall back silently to locally-stored keys.
    }
  }
}))

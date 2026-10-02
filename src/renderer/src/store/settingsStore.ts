import { create } from 'zustand'
import type { KeymapScheme } from '../lib/keymap'
import type { ExportEngine, ResolutionHeight } from '@shared/types'

const STORAGE_KEY = 've-youtube-api-key'
const JAMENDO_STORAGE_KEY = 've-jamendo-client-id'
const FREESOUND_STORAGE_KEY = 've-freesound-api-key'
const GEMINI_STORAGE_KEY = 've-gemini-api-key'
const KEYMAP_STORAGE_KEY = 've-keymap-scheme'
const SNAP_ENABLED_KEY = 've-snap-enabled'
const SHORTCUT_GUIDE_VISIBLE_KEY = 've-shortcut-guide-visible'
const SHORT_NOTE_KEY = 've-short-note'
const EXPORT_RESOLUTION_KEY = 've-export-resolution'
const EXPORT_ENGINE_KEY = 've-export-engine'

const RESOLUTION_HEIGHTS: ResolutionHeight[] = [480, 720, 1080, 1440]

// プレビューのテロップは「出力ピクセル」を枠の大きさへ換算して描くため、
// 書き出しの解像度をプレビュー側からも読める必要がある。
function readExportResolution(): ResolutionHeight {
  const n = Number(localStorage.getItem(EXPORT_RESOLUTION_KEY))
  return RESOLUTION_HEIGHTS.includes(n as ResolutionHeight) ? (n as ResolutionHeight) : 1080
}

function readExportEngine(): ExportEngine {
  try {
    return localStorage.getItem(EXPORT_ENGINE_KEY) === 'segmented' ? 'segmented' : 'standard'
  } catch {
    return 'standard'
  }
}

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
  /** 書き出しの解像度。プレビューのテロップ換算にも使うので画面をまたいで共有する */
  exportResolutionHeight: ResolutionHeight
  setExportResolutionHeight: (height: ResolutionHeight) => void
  /**
   * 書き出しの方式。プレビューのテロップの描き方もこれに合わせる
   * (長尺向けは共通テロップレンダラで書き出すので、画面も同じ関数で描く)
   */
  exportEngine: ExportEngine
  setExportEngine: (engine: ExportEngine) => void
  /** AIショート生成に渡す編集方針。書き直す手間を省くため次回起動時まで残す */
  shortNote: string
  setShortNote: (note: string) => void
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
  exportResolutionHeight: readExportResolution(),
  setExportResolutionHeight: (height) => {
    localStorage.setItem(EXPORT_RESOLUTION_KEY, String(height))
    set({ exportResolutionHeight: height })
  },
  exportEngine: readExportEngine(),
  setExportEngine: (engine) => {
    try {
      localStorage.setItem(EXPORT_ENGINE_KEY, engine)
    } catch {
      // 保存できなくても今回の起動の間は効く
    }
    set({ exportEngine: engine })
  },
  shortNote: localStorage.getItem(SHORT_NOTE_KEY) ?? '',
  setShortNote: (note) => {
    localStorage.setItem(SHORT_NOTE_KEY, note)
    set({ shortNote: note })
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

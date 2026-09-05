import { create } from 'zustand'
import type { KeymapScheme } from '../lib/keymap'
import type { ResolutionHeight } from '@shared/types'

const STORAGE_KEY = 've-youtube-api-key'
const JAMENDO_STORAGE_KEY = 've-jamendo-client-id'
const FREESOUND_STORAGE_KEY = 've-freesound-api-key'
const GEMINI_STORAGE_KEY = 've-gemini-api-key'
const KEYMAP_STORAGE_KEY = 've-keymap-scheme'
const SNAP_ENABLED_KEY = 've-snap-enabled'
const SHORTCUT_GUIDE_VISIBLE_KEY = 've-shortcut-guide-visible'
const SHORT_NOTE_KEY = 've-short-note'
const EXPORT_RESOLUTION_KEY = 've-export-resolution'
const TREND_VERIFY_KEY = 've-trend-verify-enabled'
const CHANNEL_INPUT_KEY = 've-channel-input'
const CHANNEL_RIVALS_KEY = 've-channel-rivals'
const CHANNEL_RESEARCH_KEY = 've-channel-research-enabled'

const RESOLUTION_HEIGHTS: ResolutionHeight[] = [480, 720, 1080, 1440]

// プレビューのテロップは「出力ピクセル」を枠の大きさへ換算して描くため、
// 書き出しの解像度をプレビュー側からも読める必要がある。
function readExportResolution(): ResolutionHeight {
  const n = Number(localStorage.getItem(EXPORT_RESOLUTION_KEY))
  return RESOLUTION_HEIGHTS.includes(n as ResolutionHeight) ? (n as ResolutionHeight) : 1080
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
  /** AIショート生成に渡す編集方針。書き直す手間を省くため次回起動時まで残す */
  shortNote: string
  setShortNote: (note: string) => void
  /**
   * ゲームリサーチで候補をYouTube検索まで裏取りするか。
   * 精度が上がる代わりにYouTube APIの消費が増えるので、選んだ設定を次回まで残す
   * (毎回チェックし直させると、上限を気にする人が結局使わなくなる)。
   */
  trendVerifyEnabled: boolean
  setTrendVerifyEnabled: (enabled: boolean) => void
  /** チャンネル分析で調べる自分のチャンネル。毎回貼り直さずに済むよう残す */
  channelInput: string
  setChannelInput: (value: string) => void
  /** 比較したいチャンネル(1行に1つ) */
  channelRivals: string
  setChannelRivals: (value: string) => void
  /** チャンネル分析で外部ニュースまで調べるか */
  channelResearchEnabled: boolean
  setChannelResearchEnabled: (enabled: boolean) => void
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
  shortNote: localStorage.getItem(SHORT_NOTE_KEY) ?? '',
  setShortNote: (note) => {
    localStorage.setItem(SHORT_NOTE_KEY, note)
    set({ shortNote: note })
  },
  // 既定は ON。既定を OFF にすると、一番効く裏取りが**使われないまま**
  // 「精度が低い」と見られる
  trendVerifyEnabled: localStorage.getItem(TREND_VERIFY_KEY) !== 'false',
  setTrendVerifyEnabled: (enabled) => {
    localStorage.setItem(TREND_VERIFY_KEY, String(enabled))
    set({ trendVerifyEnabled: enabled })
  },
  channelInput: localStorage.getItem(CHANNEL_INPUT_KEY) ?? '',
  setChannelInput: (value) => {
    localStorage.setItem(CHANNEL_INPUT_KEY, value)
    set({ channelInput: value })
  },
  channelRivals: localStorage.getItem(CHANNEL_RIVALS_KEY) ?? '',
  setChannelRivals: (value) => {
    localStorage.setItem(CHANNEL_RIVALS_KEY, value)
    set({ channelRivals: value })
  },
  channelResearchEnabled: localStorage.getItem(CHANNEL_RESEARCH_KEY) !== 'false',
  setChannelResearchEnabled: (enabled) => {
    localStorage.setItem(CHANNEL_RESEARCH_KEY, String(enabled))
    set({ channelResearchEnabled: enabled })
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

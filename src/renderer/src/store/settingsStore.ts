import { normalizeShowStyle, type ShowStyle } from '@shared/style/showStyle'
import {
  addFavoriteColor,
  normalizeFavoriteColors,
  normalizeRecentColors,
  pushRecentColor
} from '../lib/colorValue'
import {
  addFavoriteGradient,
  MAX_SECTION_PRESETS,
  normalizeFavoriteGradients,
  normalizeSectionPresets,
  SECTION_KEYS,
  SECTION_LABEL,
  type FavoriteGradient,
  type SectionPreset
} from '../lib/appearancePresets'
import type { TelopGradient, TextStyle } from '@shared/types'
import { create } from 'zustand'
import type { KeymapScheme } from '../lib/keymap'
import type { ExportEngine, QualityPreset, ResolutionHeight } from '@shared/types'
import type { LoudnessTarget } from '@shared/loudness'
import type { AiProvider } from '@shared/llm'

const STORAGE_KEY = 've-youtube-api-key'
const JAMENDO_STORAGE_KEY = 've-jamendo-client-id'
const FREESOUND_STORAGE_KEY = 've-freesound-api-key'
const GEMINI_STORAGE_KEY = 've-gemini-api-key'
const KEYMAP_STORAGE_KEY = 've-keymap-scheme'
const SNAP_ENABLED_KEY = 've-snap-enabled'
// 初期状態は隠す(常に出ていると邪魔、という声を受けて v2 で既定を変えた)。
// 出したいときはヘルプ > キーボードショートカット
const SHORTCUT_GUIDE_VISIBLE_KEY = 've-shortcut-guide-visible-v2'
const SHORT_NOTE_KEY = 've-short-note'
const EXPORT_RESOLUTION_KEY = 've-export-resolution'
const EXPORT_ENGINE_KEY = 've-export-engine'
const EXPORT_QUALITY_KEY = 've-export-quality'
const EXPORT_LOUDNESS_KEY = 've-export-loudness'
const EXPORT_OPEN_FOLDER_KEY = 've-export-open-folder'
const TELOP_DICTIONARY_KEY = 've-telop-dictionary'
const QC_WORDS_KEY = 've-qc-words'
const SHOW_KIT_KEY = 've-show-kit-folder'
const SHOW_STYLE_KEY = 've-show-style'
const AI_PROVIDER_KEY = 've-ai-provider'
const FAVORITE_COLORS_KEY = 've-favorite-colors'
const FAVORITE_GRADIENTS_KEY = 've-favorite-gradients'
const RECENT_COLORS_KEY = 've-recent-colors'
const SECTION_PRESETS_KEY = 've-section-presets'

/** 書き出しの音量の扱い。`off` は正規化しない */
export type ExportLoudness = 'off' | LoudnessTarget

function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return allowed.includes(v as T) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 保存できなくても今回の起動の間は効く
  }
}

const RESOLUTION_HEIGHTS: ResolutionHeight[] = [480, 720, 1080, 1440, 2160]

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
   * 書き出しの方式。テロップはどちらでも共通テロップレンダラで描くので、プレビューは変わらない
   */
  exportEngine: ExportEngine
  setExportEngine: (engine: ExportEngine) => void
  /** 書き出しの画質・音量・終わったらフォルダを開くか。書き出し設定を次回も覚えておく */
  exportQuality: QualityPreset
  setExportQuality: (quality: QualityPreset) => void
  exportLoudness: ExportLoudness
  setExportLoudness: (loudness: ExportLoudness) => void
  exportOpenFolderAfter: boolean
  setExportOpenFolderAfter: (open: boolean) => void
  /**
   * 用語の辞書(「誤 → 正」を1行ずつ)。発言テロップを作るときに当てる。
   * 番組をまたいで使う(出演者名・地名・番組用語)
   */
  telopDictionary: string
  setTelopDictionary: (text: string) => void
  /** 書き出し後の確認で、テロップに入っていたら知らせる言葉(1行に1つ) */
  qcWords: string
  setQcWords: (text: string) => void
  /** 番組素材フォルダ(中に SE / BGM / CG)。自動編集が SE・BGM を選ぶ。空なら置かない */
  showKitFolder: string
  setShowKitFolder: (folder: string) => void
  /** 過去回から学んだ番組スタイル(無ければ既定値で編集する)と、学んだ回の名前 */
  showStyle: { style: ShowStyle; sources: string[] } | null
  setShowStyle: (value: { style: ShowStyle; sources: string[] } | null) => void
  /** 構成の判定・演出テロップの提案に使う AI(既定はこのPC。無料・素材が外に出ない) */
  aiProvider: AiProvider
  setAiProvider: (provider: AiProvider) => void
  /** お気に入りの色(`#rrggbb`。新しいものが先頭)。テロップ・サムネイルの色の欄で使い回す */
  favoriteColors: string[]
  addFavoriteColor: (color: string) => void
  removeFavoriteColor: (color: string) => void
  /** 最近使った色(自動で覚える。新しいものが先頭、12 色まで) */
  recentColors: string[]
  pushRecentColor: (color: string) => void
  /** お気に入りのグラデーション(どのグラデーション欄からでも使える) */
  favoriteGradients: FavoriteGradient[]
  addFavoriteGradient: (gradient: TelopGradient, name?: string) => void
  renameFavoriteGradient: (id: string, name: string) => void
  removeFavoriteGradient: (id: string) => void
  /** 項目(縁・影・背景・動きなど)ごとのマイ設定 */
  sectionPresets: Record<string, SectionPreset[]>
  addSectionPreset: (section: string, name: string, values: Partial<TextStyle>) => void
  removeSectionPreset: (section: string, id: string) => void
  /** 消したマイ設定を、元の id・元の位置へ戻す(「元に戻す」。同じ名前の別の設定を上書きしない) */
  restoreSectionPreset: (section: string, preset: SectionPreset, index: number) => void
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
  shortcutGuideVisible: localStorage.getItem(SHORTCUT_GUIDE_VISIBLE_KEY) === 'true',
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
  exportQuality: readChoice<QualityPreset>(
    EXPORT_QUALITY_KEY,
    ['high', 'standard', 'small'],
    'high'
  ),
  setExportQuality: (quality) => {
    writeSetting(EXPORT_QUALITY_KEY, quality)
    set({ exportQuality: quality })
  },
  exportLoudness: readChoice<ExportLoudness>(
    EXPORT_LOUDNESS_KEY,
    ['off', 'web', 'broadcast'],
    'web'
  ),
  setExportLoudness: (loudness) => {
    writeSetting(EXPORT_LOUDNESS_KEY, loudness)
    set({ exportLoudness: loudness })
  },
  exportOpenFolderAfter: readChoice(EXPORT_OPEN_FOLDER_KEY, ['true', 'false'], 'false') === 'true',
  setExportOpenFolderAfter: (open) => {
    writeSetting(EXPORT_OPEN_FOLDER_KEY, String(open))
    set({ exportOpenFolderAfter: open })
  },
  telopDictionary: (() => {
    try {
      return localStorage.getItem(TELOP_DICTIONARY_KEY) ?? ''
    } catch {
      return ''
    }
  })(),
  setTelopDictionary: (text) => {
    writeSetting(TELOP_DICTIONARY_KEY, text)
    set({ telopDictionary: text })
  },
  qcWords: (() => {
    try {
      return localStorage.getItem(QC_WORDS_KEY) ?? ''
    } catch {
      return ''
    }
  })(),
  setQcWords: (text) => {
    writeSetting(QC_WORDS_KEY, text)
    set({ qcWords: text })
  },
  showKitFolder: (() => {
    try {
      return localStorage.getItem(SHOW_KIT_KEY) ?? ''
    } catch {
      return ''
    }
  })(),
  setShowKitFolder: (folder) => {
    writeSetting(SHOW_KIT_KEY, folder)
    set({ showKitFolder: folder })
  },
  showStyle: (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(SHOW_STYLE_KEY) ?? 'null') as {
        style?: unknown
        sources?: unknown
      } | null
      if (!raw || typeof raw !== 'object') return null
      return {
        style: normalizeShowStyle(raw.style),
        sources: Array.isArray(raw.sources)
          ? raw.sources.filter((x): x is string => typeof x === 'string')
          : []
      }
    } catch {
      return null
    }
  })(),
  setShowStyle: (value) => {
    writeSetting(SHOW_STYLE_KEY, JSON.stringify(value))
    set({ showStyle: value })
  },
  aiProvider: readChoice<AiProvider>(AI_PROVIDER_KEY, ['local', 'gemini', 'off'], 'local'),
  setAiProvider: (provider) => {
    writeSetting(AI_PROVIDER_KEY, provider)
    set({ aiProvider: provider })
  },
  favoriteColors: (() => {
    try {
      return normalizeFavoriteColors(JSON.parse(localStorage.getItem(FAVORITE_COLORS_KEY) ?? '[]'))
    } catch {
      return []
    }
  })(),
  addFavoriteColor: (color) =>
    set((s) => {
      const favoriteColors = addFavoriteColor(s.favoriteColors, color)
      writeSetting(FAVORITE_COLORS_KEY, JSON.stringify(favoriteColors))
      return { favoriteColors }
    }),
  removeFavoriteColor: (color) =>
    set((s) => {
      const favoriteColors = s.favoriteColors.filter((c) => c !== color)
      writeSetting(FAVORITE_COLORS_KEY, JSON.stringify(favoriteColors))
      return { favoriteColors }
    }),
  recentColors: (() => {
    try {
      return normalizeRecentColors(JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? '[]'))
    } catch {
      return []
    }
  })(),
  pushRecentColor: (color) =>
    set((s) => {
      const recentColors = pushRecentColor(s.recentColors, color)
      if (recentColors.join() === s.recentColors.join()) return s
      writeSetting(RECENT_COLORS_KEY, JSON.stringify(recentColors))
      return { recentColors }
    }),
  favoriteGradients: (() => {
    try {
      return normalizeFavoriteGradients(
        JSON.parse(localStorage.getItem(FAVORITE_GRADIENTS_KEY) ?? '[]')
      )
    } catch {
      return []
    }
  })(),
  addFavoriteGradient: (gradient, name = '') =>
    set((s) => {
      const favoriteGradients = addFavoriteGradient(
        s.favoriteGradients,
        gradient,
        name,
        `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      )
      writeSetting(FAVORITE_GRADIENTS_KEY, JSON.stringify(favoriteGradients))
      return { favoriteGradients }
    }),
  renameFavoriteGradient: (id, name) =>
    set((s) => {
      const favoriteGradients = s.favoriteGradients.map((f) =>
        f.id === id ? { ...f, name: name.trim() || f.name } : f
      )
      writeSetting(FAVORITE_GRADIENTS_KEY, JSON.stringify(favoriteGradients))
      return { favoriteGradients }
    }),
  removeFavoriteGradient: (id) =>
    set((s) => {
      const favoriteGradients = s.favoriteGradients.filter((f) => f.id !== id)
      writeSetting(FAVORITE_GRADIENTS_KEY, JSON.stringify(favoriteGradients))
      return { favoriteGradients }
    }),
  sectionPresets: (() => {
    try {
      return normalizeSectionPresets(
        JSON.parse(localStorage.getItem(SECTION_PRESETS_KEY) ?? '{}'),
        (section) => (Object.hasOwn(SECTION_KEYS, section) ? SECTION_KEYS[section] : undefined)
      )
    } catch {
      return {}
    }
  })(),
  addSectionPreset: (section, name, values) =>
    set((s) => {
      const keys = SECTION_KEYS[section]
      if (!keys) return s
      const list = s.sectionPresets[section] ?? []
      const preset: SectionPreset = {
        id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim() || `${SECTION_LABEL[section] ?? ''} ${list.length + 1}`,
        values
      }
      // 同じ名前は置き換える(上書き保存)
      const next = [preset, ...list.filter((p) => p.name !== preset.name)].slice(
        0,
        MAX_SECTION_PRESETS
      )
      const sectionPresets = { ...s.sectionPresets, [section]: next }
      writeSetting(SECTION_PRESETS_KEY, JSON.stringify(sectionPresets))
      return { sectionPresets }
    }),
  removeSectionPreset: (section, id) =>
    set((s) => {
      const sectionPresets = {
        ...s.sectionPresets,
        [section]: (s.sectionPresets[section] ?? []).filter((p) => p.id !== id)
      }
      writeSetting(SECTION_PRESETS_KEY, JSON.stringify(sectionPresets))
      return { sectionPresets }
    }),
  restoreSectionPreset: (section, preset, index) =>
    set((s) => {
      if (!SECTION_KEYS[section]) return s
      const list = (s.sectionPresets[section] ?? []).filter((p) => p.id !== preset.id)
      const at = Math.max(0, Math.min(list.length, Math.floor(index)))
      const next = [...list.slice(0, at), preset, ...list.slice(at)].slice(0, MAX_SECTION_PRESETS)
      const sectionPresets = { ...s.sectionPresets, [section]: next }
      writeSetting(SECTION_PRESETS_KEY, JSON.stringify(sectionPresets))
      return { sectionPresets }
    }),
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

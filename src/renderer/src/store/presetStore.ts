import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { TextStyle } from '@shared/types'

const CAPTION_PRESETS_KEY = 've-caption-presets'
const SE_PRESETS_KEY = 've-se-presets'

export interface CaptionPreset {
  id: string
  name: string
  style: TextStyle
}

export interface SePreset {
  id: string
  name: string
  filePath: string
  fileName: string
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

interface PresetState {
  captionPresets: CaptionPreset[]
  sePresets: SePreset[]
  addCaptionPreset: (name: string, style: TextStyle) => void
  removeCaptionPreset: (id: string) => void
  addSePreset: (name: string, filePath: string, fileName: string) => void
  removeSePreset: (id: string) => void
}

export const usePresetStore = create<PresetState>((set, get) => ({
  captionPresets: loadJson(CAPTION_PRESETS_KEY, []),
  sePresets: loadJson(SE_PRESETS_KEY, []),

  addCaptionPreset: (name, style) => {
    const next = [...get().captionPresets, { id: uuid(), name, style: { ...style } }]
    localStorage.setItem(CAPTION_PRESETS_KEY, JSON.stringify(next))
    set({ captionPresets: next })
  },

  removeCaptionPreset: (id) => {
    const next = get().captionPresets.filter((p) => p.id !== id)
    localStorage.setItem(CAPTION_PRESETS_KEY, JSON.stringify(next))
    set({ captionPresets: next })
  },

  addSePreset: (name, filePath, fileName) => {
    const next = [...get().sePresets, { id: uuid(), name, filePath, fileName }]
    localStorage.setItem(SE_PRESETS_KEY, JSON.stringify(next))
    set({ sePresets: next })
  },

  removeSePreset: (id) => {
    const next = get().sePresets.filter((p) => p.id !== id)
    localStorage.setItem(SE_PRESETS_KEY, JSON.stringify(next))
    set({ sePresets: next })
  }
}))

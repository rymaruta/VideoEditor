import { create } from 'zustand'

const STORAGE_KEY = 've-youtube-api-key'

interface SettingsState {
  youtubeApiKey: string
  setYoutubeApiKey: (key: string) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  youtubeApiKey: localStorage.getItem(STORAGE_KEY) ?? '',
  setYoutubeApiKey: (key) => {
    localStorage.setItem(STORAGE_KEY, key)
    set({ youtubeApiKey: key })
  }
}))

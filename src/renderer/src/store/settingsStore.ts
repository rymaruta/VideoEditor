import { create } from 'zustand'

const STORAGE_KEY = 've-youtube-api-key'
const JAMENDO_STORAGE_KEY = 've-jamendo-client-id'
const FREESOUND_STORAGE_KEY = 've-freesound-api-key'

interface SettingsState {
  youtubeApiKey: string
  setYoutubeApiKey: (key: string) => void
  jamendoClientId: string
  setJamendoClientId: (key: string) => void
  freesoundApiKey: string
  setFreesoundApiKey: (key: string) => void
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
  }
}))

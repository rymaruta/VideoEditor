import { create } from 'zustand'
import type { VoicevoxSpeaker } from '@shared/types'
import { formatIpcError } from '../lib/ipcError'

/**
 * VOICEVOX(ナレーションの音声合成)の話者の一覧と、つないだ状態。
 * つなぐのはナレーションのパネルを開いた時だけ(`connectIfNeeded`)。左のパネルは切り替えても
 * 消さずに置いておくため、パネルを置いた時(起動の直後)につないでいて、ナレーションを使わない人でも
 * 起動のたびに「VOICEVOX Engine に接続できません」がメインの記録に残っていた
 */
export type VoicevoxStatus = 'idle' | 'loading' | 'ready' | 'error'

interface VoicevoxState {
  status: VoicevoxStatus
  speakers: VoicevoxSpeaker[]
  error: string | null
  /** まだつないでいなければつなぐ(つないでいる最中・済み・失敗の後は何もしない) */
  connectIfNeeded: () => void
  /** つなぎ直す(「再接続」) */
  connect: () => Promise<void>
}

export const useVoicevoxStore = create<VoicevoxState>((set, get) => ({
  status: 'idle',
  speakers: [],
  error: null,
  connectIfNeeded: () => {
    if (get().status === 'idle') void get().connect()
  },
  connect: async () => {
    if (get().status === 'loading') return
    set({ status: 'loading', error: null })
    try {
      const speakers = await window.api.voicevoxListSpeakers()
      set({ status: 'ready', speakers })
    } catch (e) {
      set({ status: 'error', error: formatIpcError(e) })
    }
  }
}))

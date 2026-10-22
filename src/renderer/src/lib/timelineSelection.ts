import { create } from 'zustand'
import { useProjectStore } from '../store/projectStore'

/**
 * タイムラインで選んでいる、本編以外のクリップ(音声・PiP)。
 *
 * 選択そのものは `Timeline` の中の状態で、Delete・分割もそこが受け持つ。ところが
 * 全体のキー処理(`useKeyboardShortcuts`)からは見えないので、音声・PiP を選んで
 * Shift+Delete を押すと、タイムラインがそのクリップを消し、全体のキー処理は「何も選んでいない」と
 * 読んでイン〜アウトまで抜いていた(1回の押下で2つの操作・履歴 +2)。
 * `Timeline` が選びを変えるたびにここへ写し、全体のキー処理はここを見る
 */
export interface SubClipRef {
  trackId: string
  clipId: string
}

export const useTimelineSubSelection = create<{
  audio: SubClipRef | null
  videoOverlay: SubClipRef | null
  setSubSelection: (audio: SubClipRef | null, videoOverlay: SubClipRef | null) => void
}>((set) => ({
  audio: null,
  videoOverlay: null,
  setSubSelection: (audio, videoOverlay) => set({ audio, videoOverlay })
}))

/** 本編以外(音声・PiP・テロップ)を選んでいるか。その間の削除はタイムライン側の処理だけが行う */
export function hasNonMainSelection(): boolean {
  const sub = useTimelineSubSelection.getState()
  return Boolean(sub.audio || sub.videoOverlay || useProjectStore.getState().selectedOverlayId)
}

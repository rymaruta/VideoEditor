import { create } from 'zustand'

/**
 * 自動保存データの状態を、起動時の確認モーダルと上部バーの復元ボタンで共有する。
 *
 * 「破棄する」を押した瞬間に退避が生まれ、上部バーにはその復元ボタンが出る。
 * どちらか一方だけが知っている形にすると、破棄してもボタンが出ない(再起動するまで
 * 気付けない)ため、1箇所に持たせて両方が同じ値を見る。
 */
interface AutosaveState {
  /** 起動時に見つかった未復元の自動保存データ(確認モーダルを出す条件) */
  pending: { mtimeMs?: number } | null
  /** 破棄して退避したデータ。あれば戻せる */
  discarded: { mtimeMs?: number } | null
  refresh: () => Promise<void>
  clearPending: () => void
}

export const useAutosaveStore = create<AutosaveState>((set) => ({
  pending: null,
  discarded: null,
  refresh: async () => {
    const status = await window.api.checkAutosave()
    set({
      pending: status.exists ? { mtimeMs: status.mtimeMs } : null,
      discarded: status.discardedExists ? { mtimeMs: status.discardedMtimeMs } : null
    })
  },
  clearPending: () => set({ pending: null })
}))

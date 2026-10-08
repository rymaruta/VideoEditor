import { describe, expect, it } from 'vitest'
import { useAutosaveStore } from '@renderer/store/autosaveStore'

describe('自動保存の状態', () => {
  it('作業中の自動保存のあとは、退避したデータだけを読み直す(起動時の確認を出し直さない)', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        checkAutosave: async () => ({
          exists: true,
          mtimeMs: 1,
          discardedExists: true,
          discardedMtimeMs: 2
        })
      }
    }
    useAutosaveStore.setState({ pending: null, discarded: null })
    await useAutosaveStore.getState().refreshDiscarded()
    expect(useAutosaveStore.getState().pending).toBeNull()
    expect(useAutosaveStore.getState().discarded).toEqual({ mtimeMs: 2 })
  })

  it('確認を出したまま自動保存が退避されたら、確認も閉じる', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        checkAutosave: async () => ({ exists: false, discardedExists: true, discardedMtimeMs: 3 })
      }
    }
    useAutosaveStore.setState({ pending: { mtimeMs: 1 }, discarded: null })
    await useAutosaveStore.getState().refreshDiscarded()
    expect(useAutosaveStore.getState().pending).toBeNull()
  })

  it('確認を出したまま自動保存が前回の分を退避して書き直したら、確認を閉じる', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        checkAutosave: async () => ({
          exists: true,
          mtimeMs: 99,
          discardedExists: true,
          discardedMtimeMs: 1
        })
      }
    }
    useAutosaveStore.setState({ pending: { mtimeMs: 1 }, discarded: null })
    await useAutosaveStore.getState().refreshDiscarded()
    expect(useAutosaveStore.getState().pending).toBeNull()
  })
})

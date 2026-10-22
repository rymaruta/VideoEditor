import { describe, expect, it, vi } from 'vitest'

/**
 * 自動編集の文字起こしの言語は、番組の種類と同じく設定に覚え、認識する main に伝える
 * (自動編集の流れ・preload の呼び出しを変えずに、選んだ言語で認識させる)
 */
describe('文字起こしの言語の設定', () => {
  it('起動時と選び直したときに main へ伝え、次の起動まで覚える', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    })
    const sent: string[] = []
    vi.stubGlobal('window', { api: { asrSetLanguage: async (l: string) => void sent.push(l) } })
    vi.resetModules()
    const { useSettingsStore } = await import('../../src/renderer/src/store/settingsStore')
    // 既定は今までどおり日本語
    expect(useSettingsStore.getState().asrLanguage).toBe('japanese')
    expect(sent).toEqual(['japanese'])
    useSettingsStore.getState().setAsrLanguage('english')
    expect(sent).toEqual(['japanese', 'english'])
    expect(store.get('ve-asr-language')).toBe('english')

    sent.length = 0
    vi.resetModules()
    const again = await import('../../src/renderer/src/store/settingsStore')
    expect(again.useSettingsStore.getState().asrLanguage).toBe('english')
    expect(sent).toEqual(['english'])
    vi.unstubAllGlobals()
  })

  it('preload が古い(伝える口が無い)・画面が無いときも落ちない', async () => {
    vi.stubGlobal('window', { api: {} })
    vi.resetModules()
    const { useSettingsStore } = await import('../../src/renderer/src/store/settingsStore')
    expect(() => useSettingsStore.getState().setAsrLanguage('auto')).not.toThrow()
    vi.unstubAllGlobals()
  })
})

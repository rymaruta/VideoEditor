import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * API キーは暗号化して main に置く。前の版(10/09 版 c25f5af 以前も同じ名前)が localStorage に
 * 平文で置いた鍵は、起動時に移して消す。暗号化できない PC では今までどおり localStorage。
 */

/** 10/09 版の設定(鍵とほかの設定) */
function oldSettings(): Map<string, string> {
  return new Map([
    ['ve-gemini-api-key', 'AIza-old-gemini'],
    ['ve-youtube-api-key', 'yt-old'],
    ['ve-jamendo-client-id', 'jam-old'],
    ['ve-freesound-api-key', 'fs-old'],
    ['ve-keymap-scheme', 'premiere'],
    ['ve-ai-provider', 'gemini']
  ])
}

function stubStorage(store: Map<string, string>): void {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)
  })
}

/** main の側(暗号化した保存)の代わり */
function stubMain(
  secrets: Map<string, string>,
  options: { available?: boolean; failSet?: boolean; env?: Record<string, string> } = {}
): { calls: [string, string][]; release: () => void } {
  const calls: [string, string][] = []
  let release = (): void => {}
  const gate = new Promise<void>((r) => (release = r))
  vi.stubGlobal('window', {
    api: {
      asrSetLanguage: async () => {},
      secretsLoad: async () => {
        await gate
        return options.available === false
          ? { available: false, reason: '鍵の保管場所がありません。', values: {} }
          : { available: true, values: Object.fromEntries(secrets) }
      },
      secretsSet: async (name: string, value: string) => {
        calls.push([name, value])
        if (options.failSet || options.available === false) return false
        if (value) secrets.set(name, value)
        else secrets.delete(name)
        return true
      },
      getEnvApiKeys: async () => ({
        geminiApiKey: '',
        youtubeApiKey: '',
        jamendoClientId: '',
        freesoundApiKey: '',
        ...options.env
      })
    }
  })
  return { calls, release }
}

async function loadStore(): Promise<
  (typeof import('../../src/renderer/src/store/settingsStore'))['useSettingsStore']
> {
  vi.resetModules()
  return (await import('../../src/renderer/src/store/settingsStore')).useSettingsStore
}

afterEach(() => vi.unstubAllGlobals())

describe('API キーの移し替え', () => {
  it('前の版の平文の鍵を main へ移して消し、次の起動からは main から読む(ほかの設定は残す)', async () => {
    const storage = oldSettings()
    stubStorage(storage)
    const secrets = new Map<string, string>()
    const main = stubMain(secrets)
    let useSettingsStore = await loadStore()
    // 移す前から、前の版の鍵で使える(起動直後に鍵が空にならない)
    expect(useSettingsStore.getState().geminiApiKey).toBe('AIza-old-gemini')
    expect(useSettingsStore.getState().keyStorage).toBe('pending')
    main.release()
    await useSettingsStore.getState().loadEnvApiKeys()
    expect(useSettingsStore.getState().keyStorage).toBe('encrypted')
    expect(Object.fromEntries(secrets)).toEqual({
      geminiApiKey: 'AIza-old-gemini',
      youtubeApiKey: 'yt-old',
      jamendoClientId: 'jam-old',
      freesoundApiKey: 'fs-old'
    })
    for (const k of [
      've-gemini-api-key',
      've-youtube-api-key',
      've-jamendo-client-id',
      've-freesound-api-key'
    ])
      expect(storage.has(k)).toBe(false)
    expect(storage.get('ve-keymap-scheme')).toBe('premiere')
    expect(useSettingsStore.getState().aiProvider).toBe('gemini')

    // 次の起動: localStorage には無いが、main から読む
    stubMain(secrets).release()
    useSettingsStore = await loadStore()
    await useSettingsStore.getState().loadEnvApiKeys()
    expect(storage.has('ve-gemini-api-key')).toBe(false)
    expect(useSettingsStore.getState().geminiApiKey).toBe('AIza-old-gemini')
    expect(useSettingsStore.getState().freesoundApiKey).toBe('fs-old')

    // 入れ直した鍵は main へ。localStorage には書かない
    useSettingsStore.getState().setGeminiApiKey('AIza-new')
    await Promise.resolve()
    await Promise.resolve()
    expect(secrets.get('geminiApiKey')).toBe('AIza-new')
    expect(storage.has('ve-gemini-api-key')).toBe(false)
  })

  it('暗号化できない PC では今までどおり localStorage に置き、その旨を出す', async () => {
    const storage = oldSettings()
    stubStorage(storage)
    stubMain(new Map(), { available: false }).release()
    const useSettingsStore = await loadStore()
    await useSettingsStore.getState().loadEnvApiKeys()
    expect(useSettingsStore.getState().keyStorage).toBe('plain')
    expect(useSettingsStore.getState().keyStorageNote).toContain('鍵の保管場所')
    expect(useSettingsStore.getState().youtubeApiKey).toBe('yt-old')
    expect(storage.get('ve-youtube-api-key')).toBe('yt-old')
    useSettingsStore.getState().setYoutubeApiKey('yt-new')
    expect(storage.get('ve-youtube-api-key')).toBe('yt-new')
  })

  it('main に保存できなかった鍵は消さずに残し、その値を使う', async () => {
    const storage = oldSettings()
    stubStorage(storage)
    stubMain(new Map(), { failSet: true }).release()
    const useSettingsStore = await loadStore()
    await useSettingsStore.getState().loadEnvApiKeys()
    expect(storage.get('ve-gemini-api-key')).toBe('AIza-old-gemini')
    expect(useSettingsStore.getState().geminiApiKey).toBe('AIza-old-gemini')
    // 入れ直しも失わない(localStorage へ退避)
    useSettingsStore.getState().setGeminiApiKey('AIza-typed')
    await new Promise((r) => setTimeout(r, 0))
    expect(storage.get('ve-gemini-api-key')).toBe('AIza-typed')
  })

  it('起動直後(読み込み中)に入れた鍵は、読み込んだ値で上書きせず、その順で保存する', async () => {
    const storage = oldSettings()
    stubStorage(storage)
    const secrets = new Map<string, string>()
    const main = stubMain(secrets)
    const useSettingsStore = await loadStore()
    useSettingsStore.getState().setGeminiApiKey('AIza-typed-1')
    useSettingsStore.getState().setGeminiApiKey('AIza-typed-2')
    main.release()
    await useSettingsStore.getState().loadEnvApiKeys()
    await new Promise((r) => setTimeout(r, 0))
    expect(useSettingsStore.getState().geminiApiKey).toBe('AIza-typed-2')
    expect(secrets.get('geminiApiKey')).toBe('AIza-typed-2')
    expect(main.calls.map((c) => c[1]).slice(-2)).toEqual(['AIza-typed-1', 'AIza-typed-2'])
    expect(storage.has('ve-gemini-api-key')).toBe(false)
    // ほかの鍵は前の版の値が移る
    expect(useSettingsStore.getState().youtubeApiKey).toBe('yt-old')
  })

  it('.env の鍵は、保存した鍵より優先する(今までどおり)', async () => {
    stubStorage(oldSettings())
    stubMain(new Map(), { env: { geminiApiKey: 'AIza-env' } }).release()
    const useSettingsStore = await loadStore()
    await useSettingsStore.getState().loadEnvApiKeys()
    expect(useSettingsStore.getState().geminiApiKey).toBe('AIza-env')
    expect(useSettingsStore.getState().envKeySources.geminiApiKey).toBe(true)
    expect(useSettingsStore.getState().youtubeApiKey).toBe('yt-old')
  })

  it('preload が古い・画面が無いときは今までどおり localStorage(同じ時点で書く)', async () => {
    const storage = oldSettings()
    stubStorage(storage)
    vi.stubGlobal('window', { api: {} })
    const useSettingsStore = await loadStore()
    expect(useSettingsStore.getState().keyStorage).toBe('plain')
    useSettingsStore.getState().setFreesoundApiKey('fs-new')
    expect(storage.get('ve-freesound-api-key')).toBe('fs-new')
  })
})

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { SecretStore, type SecretCipher } from '@main/secretStore'

/**
 * 暗号化が使える起動と使えない起動(Linux で鍵の保管場所が無い日がある等)が混ざっても、
 * 鍵を黙って空にしない・読めない古い値で新しい値を消さない。復号できない鍵は欄で知らせる。
 * main 側は本物の SecretStore(暗号だけ試験用)で動かす。
 */
const dir = mkdtempSync(join(tmpdir(), 've-mixed-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => vi.unstubAllGlobals())

const cipher: SecretCipher & { on: boolean; key: string } = {
  on: true,
  key: 'pc1',
  isAvailable() {
    return this.on
  },
  unavailableReason: () => '鍵の保管場所が見つかりません。',
  encrypt(text) {
    return Buffer.from(`${this.key}:${text}`)
  },
  decrypt(data) {
    const s = data.toString()
    if (!s.startsWith(`${this.key}:`)) throw new Error('bad key')
    return s.slice(this.key.length + 1)
  }
}

async function boot(
  storage: Map<string, string>,
  file: string
): Promise<(typeof import('../../src/renderer/src/store/settingsStore'))['useSettingsStore']> {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k)
  })
  const store = new SecretStore(file, cipher)
  vi.stubGlobal('window', {
    api: {
      asrSetLanguage: async () => {},
      secretsLoad: async () => store.load(),
      secretsSet: async (name: string, value: string) => store.set(name, value),
      getEnvApiKeys: async () => ({})
    }
  })
  vi.resetModules()
  const { useSettingsStore } = await import('../../src/renderer/src/store/settingsStore')
  await useSettingsStore.getState().loadEnvApiKeys()
  return useSettingsStore
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('暗号化が使える起動・使えない起動の混在', () => {
  it('使えない起動で入れ直した新しい値が、使える起動に戻ったときに優先され、古い値に戻らない', async () => {
    const file = join(dir, 'a.json')
    const storage = new Map<string, string>()
    cipher.on = true
    let s = await boot(storage, file)
    s.getState().setGeminiApiKey('AIza-first')
    await settle()

    // 使えない起動: 保存した鍵は読めないと知らせ、ファイルは消さない
    cipher.on = false
    s = await boot(storage, file)
    expect(s.getState().keyStorage).toBe('plain')
    expect(s.getState().geminiApiKey).toBe('')
    expect(s.getState().unreadableKeys).toEqual(['geminiApiKey'])
    expect(s.getState().unreadableCause).toBe('unavailable')
    s.getState().setGeminiApiKey('AIza-second')
    expect(s.getState().unreadableKeys).toEqual([])
    expect(storage.get('ve-gemini-api-key')).toBe('AIza-second')

    // 使える起動に戻る: 新しい値を移し、古い値に戻らない
    cipher.on = true
    s = await boot(storage, file)
    expect(s.getState().geminiApiKey).toBe('AIza-second')
    expect(s.getState().unreadableKeys).toEqual([])
    expect(storage.has('ve-gemini-api-key')).toBe(false)
    expect(new SecretStore(file, cipher).load().values.geminiApiKey).toBe('AIza-second')
  })

  it('使えない起動で何も入れなければ、使える起動で前の鍵がそのまま戻る', async () => {
    const file = join(dir, 'b.json')
    const storage = new Map<string, string>()
    cipher.on = true
    let s = await boot(storage, file)
    s.getState().setYoutubeApiKey('yt-kept')
    await settle()
    cipher.on = false
    s = await boot(storage, file)
    expect(s.getState().youtubeApiKey).toBe('')
    cipher.on = true
    s = await boot(storage, file)
    expect(s.getState().youtubeApiKey).toBe('yt-kept')
  })

  it('復号できない鍵(別の PC から移した)は空にせず欄で知らせ、ファイルに残す。入れ直せば消える', async () => {
    const file = join(dir, 'c.json')
    const storage = new Map<string, string>()
    cipher.on = true
    cipher.key = 'pc1'
    let s = await boot(storage, file)
    s.getState().setFreesoundApiKey('fs-on-pc1')
    await settle()

    cipher.key = 'pc2'
    s = await boot(storage, file)
    expect(s.getState().freesoundApiKey).toBe('')
    expect(s.getState().unreadableKeys).toEqual(['freesoundApiKey'])
    expect(s.getState().unreadableCause).toBe('decrypt')
    // ほかの鍵を入れても、読めない鍵は消さない
    s.getState().setGeminiApiKey('AIza-pc2')
    await settle()
    cipher.key = 'pc1'
    expect(new SecretStore(file, cipher).load().values.freesoundApiKey).toBe('fs-on-pc1')
    cipher.key = 'pc2'
    s.getState().setFreesoundApiKey('fs-on-pc2')
    expect(s.getState().unreadableKeys).toEqual([])
    await settle()
    expect(new SecretStore(file, cipher).load().values.freesoundApiKey).toBe('fs-on-pc2')
    cipher.key = 'pc1'
  })

  it('前の版の空の鍵は移さない(main の鍵を消さない)。空の項目は片付ける', async () => {
    const file = join(dir, 'd.json')
    cipher.on = true
    new SecretStore(file, cipher).set('jamendoClientId', 'jam-main')
    const storage = new Map([['ve-jamendo-client-id', '']])
    const s = await boot(storage, file)
    expect(s.getState().jamendoClientId).toBe('jam-main')
    expect(storage.has('ve-jamendo-client-id')).toBe(false)
  })
})

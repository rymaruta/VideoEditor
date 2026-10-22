import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretStore, type SecretCipher } from '@main/secretStore'
import { legacySecretsToMigrate, LEGACY_SECRET_STORAGE_KEYS } from '@shared/secrets'

const dirs: string[] = []
function tempFile(): string {
  const d = mkdtempSync(join(tmpdir(), 've-secrets-'))
  dirs.push(d)
  return join(d, 'secrets.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 試験用の暗号(中身が平文で見えないように反転して印を付ける) */
function fakeCipher(available = true): SecretCipher & { key: string } {
  return {
    key: 'k1',
    isAvailable: () => available,
    unavailableReason: () => '鍵の保管場所がありません',
    encrypt(text) {
      return Buffer.from(`${this.key}:${[...text].reverse().join('')}`, 'utf-8')
    },
    decrypt(data) {
      const s = data.toString('utf-8')
      if (!s.startsWith(`${this.key}:`)) throw new Error('bad key')
      return [...s.slice(this.key.length + 1)].reverse().join('')
    }
  }
}

describe('API キーの暗号化した保存', () => {
  it('保存した鍵を読み戻せ、ファイルに平文は残らない。空で消す', () => {
    const path = tempFile()
    const store = new SecretStore(path, fakeCipher())
    expect(store.set('geminiApiKey', 'AIzaSECRET-1')).toBe(true)
    expect(store.set('freesoundApiKey', 'fs-2')).toBe(true)
    expect(readFileSync(path, 'utf-8')).not.toContain('AIzaSECRET-1')
    expect(new SecretStore(path, fakeCipher()).load()).toEqual({
      available: true,
      values: { geminiApiKey: 'AIzaSECRET-1', freesoundApiKey: 'fs-2' }
    })
    expect(store.set('geminiApiKey', '')).toBe(true)
    expect(store.load().values).toEqual({ freesoundApiKey: 'fs-2' })
  })

  it('暗号化が使えないときは書かず、理由を返す', () => {
    const path = tempFile()
    const store = new SecretStore(path, fakeCipher(false))
    expect(store.set('geminiApiKey', 'x')).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(store.load()).toEqual({
      available: false,
      reason: '鍵の保管場所がありません',
      values: {}
    })
  })

  it('知らない名前・文字列でない値・長すぎる値は受け付けない', () => {
    const store = new SecretStore(tempFile(), fakeCipher())
    expect(store.set('__proto__', 'x')).toBe(false)
    expect(store.set('openaiKey', 'x')).toBe(false)
    expect(store.set('geminiApiKey', 123)).toBe(false)
    expect(store.set('geminiApiKey', 'x'.repeat(5000))).toBe(false)
    expect(store.load().values).toEqual({})
  })

  it('復号できない値(OS の鍵が変わった)は無いものとして扱い、ほかは読める', () => {
    const path = tempFile()
    const a = fakeCipher()
    const store = new SecretStore(path, a)
    store.set('geminiApiKey', 'old')
    a.key = 'k2'
    store.set('youtubeApiKey', 'new')
    expect(new SecretStore(path, a).load().values).toEqual({ youtubeApiKey: 'new' })
    // ファイルには残す(OS の鍵が戻れば読める)
    a.key = 'k1'
    expect(new SecretStore(path, a).load().values).toEqual({ geminiApiKey: 'old' })
  })

  it('壊れたファイル・知らない項目があっても落ちず、上書きで直る', () => {
    const path = tempFile()
    writeFileSync(path, '{not json')
    const store = new SecretStore(path, fakeCipher())
    expect(store.load()).toEqual({ available: true, values: {} })
    writeFileSync(path, JSON.stringify({ secrets: { evil: 'x', geminiApiKey: 5 } }))
    expect(store.load().values).toEqual({})
    expect(store.set('jamendoClientId', 'jam')).toBe(true)
    expect(store.load().values).toEqual({ jamendoClientId: 'jam' })
  })

  it('暗号の失敗(OS の仕組みが投げた)は false で返す', () => {
    const cipher = fakeCipher()
    cipher.encrypt = () => {
      throw new Error('keychain locked')
    }
    expect(new SecretStore(tempFile(), cipher).set('geminiApiKey', 'x')).toBe(false)
  })
})

describe('前の版の localStorage から移す鍵', () => {
  it('10/09 版以前と同じ名前で読み、空(消した)も移す。読めない・長すぎるものは移さない', () => {
    // 10/09 版(c25f5af)の settingsStore と同じ名前
    expect(LEGACY_SECRET_STORAGE_KEYS).toEqual({
      youtubeApiKey: 've-youtube-api-key',
      jamendoClientId: 've-jamendo-client-id',
      freesoundApiKey: 've-freesound-api-key',
      geminiApiKey: 've-gemini-api-key'
    })
    const stored: Record<string, string> = {
      've-gemini-api-key': 'g',
      've-youtube-api-key': '',
      've-freesound-api-key': 'x'.repeat(5000)
    }
    expect(legacySecretsToMigrate((k) => stored[k] ?? null)).toEqual({
      geminiApiKey: 'g',
      youtubeApiKey: ''
    })
    expect(
      legacySecretsToMigrate(() => {
        throw new Error('storage broken')
      })
    ).toEqual({})
  })
})

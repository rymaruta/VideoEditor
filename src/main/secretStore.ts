import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import {
  isSecretName,
  MAX_SECRET_LENGTH,
  SECRET_NAMES,
  type SecretName,
  type SecretsSnapshot
} from '@shared/secrets'

/**
 * 鍵(API キー)を暗号化してファイルに置く。暗号化は `SecretCipher`(製品では Electron の safeStorage。
 * `safeStorageCipher.ts`)。ファイルの形: `{ "version": 1, "secrets": { "geminiApiKey": "<base64>" } }`。
 *
 * - 暗号化が使えないときは何も書かない(画面が今までどおり localStorage に置く)
 * - 復号できない値(OS の鍵が変わった・別の PC から持ってきた)は無いものとして扱い、ファイルには残す
 *   (後で OS の鍵が戻れば読める)。入れ直せば上書きする
 * - 書くときは一時ファイルに書いてから置き換える(途中で落ちても前の内容が残る)
 */

export interface SecretCipher {
  isAvailable(): boolean
  /** 使えないときの理由(画面に出す一文) */
  unavailableReason?(): string | undefined
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

interface SecretFile {
  version: 1
  secrets: Partial<Record<SecretName, string>>
}

export class SecretStore {
  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher
  ) {}

  private available(): boolean {
    try {
      return this.cipher.isAvailable()
    } catch {
      return false
    }
  }

  private readFile(): SecretFile {
    try {
      if (!existsSync(this.path)) return { version: 1, secrets: {} }
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as { secrets?: unknown }
      const secrets: SecretFile['secrets'] = {}
      if (raw && typeof raw.secrets === 'object' && raw.secrets !== null) {
        for (const [k, v] of Object.entries(raw.secrets as Record<string, unknown>))
          if (isSecretName(k) && typeof v === 'string') secrets[k] = v
      }
      return { version: 1, secrets }
    } catch {
      // 壊れたファイルは無いものとして扱う(上書きされるまで残す)
      return { version: 1, secrets: {} }
    }
  }

  private writeFile(file: SecretFile): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 })
    try {
      renameSync(tmp, this.path)
    } catch (e) {
      try {
        unlinkSync(tmp)
      } catch {
        // 片付けられなくても次に上書きする
      }
      throw e
    }
  }

  /** 起動時の状態と、復号できた鍵 */
  load(): SecretsSnapshot {
    if (!this.available()) {
      let reason: string | undefined
      try {
        reason = this.cipher.unavailableReason?.()
      } catch {
        reason = undefined
      }
      return { available: false, reason, values: {} }
    }
    const { secrets } = this.readFile()
    const values: SecretsSnapshot['values'] = {}
    for (const name of SECRET_NAMES) {
      const enc = secrets[name]
      if (!enc) continue
      try {
        values[name] = this.cipher.decrypt(Buffer.from(enc, 'base64'))
      } catch {
        // 復号できない値は無いものとして扱う
      }
    }
    return { available: true, values }
  }

  /** 1つ保存する(空なら消す)。保存できたら true */
  set(name: unknown, value: unknown): boolean {
    if (!isSecretName(name) || typeof value !== 'string' || value.length > MAX_SECRET_LENGTH)
      return false
    if (!this.available()) return false
    try {
      const file = this.readFile()
      if (value === '') delete file.secrets[name]
      else file.secrets[name] = this.cipher.encrypt(value).toString('base64')
      this.writeFile(file)
      return true
    } catch {
      return false
    }
  }
}

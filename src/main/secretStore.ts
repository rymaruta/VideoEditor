import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
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
 * - 暗号化が使えない起動では**ファイルに何も書かない**(読めないだけで、消さない)。画面はその起動の間
 *   今までどおり localStorage に置き、保存してある鍵を「この起動では読めない」と知らせる
 * - 復号できない値(別の PC から移した・OS の鍵が変わった)は**黙って空にしない**。ファイルには残し
 *   (OS の鍵が戻れば読める)、画面へ `unreadable` で知らせる。入れ直せばその鍵だけ上書きする
 * - 読めない(壊れた)ファイルは、上書きする前に `secrets.json.broken` に写して残す
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

  /** ファイルを読む。`corrupt` は、あるのに読めなかった(上書きする前に退避する) */
  private readFile(): { file: SecretFile; corrupt: boolean } {
    const empty: SecretFile = { version: 1, secrets: {} }
    try {
      if (!existsSync(this.path)) return { file: empty, corrupt: false }
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as { secrets?: unknown }
      const secrets: SecretFile['secrets'] = {}
      if (raw && typeof raw.secrets === 'object' && raw.secrets !== null) {
        for (const [k, v] of Object.entries(raw.secrets as Record<string, unknown>))
          if (isSecretName(k) && typeof v === 'string') secrets[k] = v
      }
      return { file: { version: 1, secrets }, corrupt: false }
    } catch {
      return { file: empty, corrupt: true }
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

  /** 起動時の状態と、復号できた鍵・読めなかった鍵 */
  load(): SecretsSnapshot {
    const { file } = this.readFile()
    const stored = SECRET_NAMES.filter((n) => Boolean(file.secrets[n]))
    if (!this.available()) {
      let reason: string | undefined
      try {
        reason = this.cipher.unavailableReason?.()
      } catch {
        reason = undefined
      }
      // 保存してある鍵は、この起動では読めないだけ(ファイルはそのまま)
      return {
        available: false,
        reason,
        values: {},
        ...(stored.length > 0
          ? { unreadable: stored, unreadableCause: 'unavailable' as const }
          : {})
      }
    }
    const values: SecretsSnapshot['values'] = {}
    const unreadable: SecretName[] = []
    for (const name of stored) {
      try {
        values[name] = this.cipher.decrypt(Buffer.from(file.secrets[name]!, 'base64'))
      } catch {
        unreadable.push(name)
      }
    }
    return {
      available: true,
      values,
      ...(unreadable.length > 0 ? { unreadable, unreadableCause: 'decrypt' as const } : {})
    }
  }

  /** 1つ保存する(空なら消す)。ほかの鍵(読めないものも)はそのまま。保存できたら true */
  set(name: unknown, value: unknown): boolean {
    if (!isSecretName(name) || typeof value !== 'string' || value.length > MAX_SECRET_LENGTH)
      return false
    // 暗号化が使えない起動では書かない(読めない鍵を空のファイルで消さない)
    if (!this.available()) return false
    try {
      const { file, corrupt } = this.readFile()
      if (corrupt) copyFileSync(this.path, `${this.path}.broken`)
      if (value === '') delete file.secrets[name]
      else file.secrets[name] = this.cipher.encrypt(value).toString('base64')
      this.writeFile(file)
      return true
    } catch {
      return false
    }
  }
}

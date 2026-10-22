import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { basename } from 'path'
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
 *   (OS の鍵が戻れば読める)、画面へ `unreadable` で知らせる。入れ直して上書きするときは、上書き前の
 *   暗号文を `secrets.json.prev` に残す(1文字打っただけで消えない)
 * - 読めない(壊れた・secrets がオブジェクトでない)ファイルは `secrets.json.broken` に移して残し
 *   (既にあれば `.broken.1` …。上書きしない)、画面へ `corrupt` で知らせる
 * - 知らない名前の鍵(新しい版が足したもの)は書き戻すときにそのまま残す。`version` が 1 より新しい
 *   ファイルには書かない(形が違うかもしれない)
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
  version: number
  /** 知っている名前も知らない名前も(書き戻すときに残す) */
  secrets: Record<string, string>
}

type ReadResult = { state: 'ok'; file: SecretFile } | { state: 'missing' } | { state: 'corrupt' }

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

  private readFile(): ReadResult {
    if (!existsSync(this.path)) return { state: 'missing' }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as {
        version?: unknown
        secrets?: unknown
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'corrupt' }
      const secretsRaw = raw.secrets ?? {}
      if (typeof secretsRaw !== 'object' || secretsRaw === null || Array.isArray(secretsRaw))
        return { state: 'corrupt' }
      const secrets: Record<string, string> = {}
      for (const [k, v] of Object.entries(secretsRaw as Record<string, unknown>))
        if (typeof v === 'string' && k !== '__proto__') secrets[k] = v
      const version = typeof raw.version === 'number' ? raw.version : 1
      return { state: 'ok', file: { version, secrets } }
    } catch {
      return { state: 'corrupt' }
    }
  }

  /** 壊れたファイルを、上書きしない名前に移す。移した先の名前 */
  private setAsideCorrupt(): string | undefined {
    for (let i = 0; i < 1000; i++) {
      const target = `${this.path}.broken${i === 0 ? '' : `.${i}`}`
      if (existsSync(target)) continue
      try {
        renameSync(this.path, target)
        return basename(target)
      } catch {
        return undefined
      }
    }
    return undefined
  }

  private writeJson(path: string, data: unknown): void {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
    try {
      renameSync(tmp, path)
    } catch (e) {
      try {
        unlinkSync(tmp)
      } catch {
        // 片付けられなくても次に上書きする
      }
      throw e
    }
  }

  private canDecrypt(enc: string): boolean {
    try {
      this.cipher.decrypt(Buffer.from(enc, 'base64'))
      return true
    } catch {
      return false
    }
  }

  /** 復号できない暗号文を上書きする前に、secrets.json.prev に残す(先に残したものは消さない) */
  private keepPrevious(name: SecretName, enc: string): void {
    const prevPath = `${this.path}.prev`
    let prev: Record<string, string> = {}
    try {
      if (existsSync(prevPath)) {
        const raw = JSON.parse(readFileSync(prevPath, 'utf-8')) as { secrets?: unknown }
        if (raw && typeof raw.secrets === 'object' && raw.secrets !== null)
          prev = { ...(raw.secrets as Record<string, string>) }
      }
    } catch {
      prev = {}
    }
    if (prev[name]) return
    prev[name] = enc
    this.writeJson(prevPath, { version: 1, secrets: prev })
  }

  /** 起動時の状態と、復号できた鍵・読めなかった鍵 */
  load(): SecretsSnapshot {
    const read = this.readFile()
    let corrupt: SecretsSnapshot['corrupt']
    if (read.state === 'corrupt') corrupt = { backup: this.setAsideCorrupt() ?? '' }
    const secrets = read.state === 'ok' ? read.file.secrets : {}
    const stored = SECRET_NAMES.filter((n) => Boolean(secrets[n]))
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
          : {}),
        ...(corrupt ? { corrupt } : {})
      }
    }
    const values: SecretsSnapshot['values'] = {}
    const unreadable: SecretName[] = []
    for (const name of stored) {
      try {
        values[name] = this.cipher.decrypt(Buffer.from(secrets[name], 'base64'))
      } catch {
        unreadable.push(name)
      }
    }
    return {
      available: true,
      values,
      ...(unreadable.length > 0 ? { unreadable, unreadableCause: 'decrypt' as const } : {}),
      ...(corrupt ? { corrupt } : {})
    }
  }

  /** 1つ保存する(空なら消す)。ほかの鍵(読めないもの・知らない名前も)はそのまま。保存できたら true */
  set(name: unknown, value: unknown): boolean {
    if (!isSecretName(name) || typeof value !== 'string' || value.length > MAX_SECRET_LENGTH)
      return false
    // 暗号化が使えない起動では書かない(読めない鍵を空のファイルで消さない)
    if (!this.available()) return false
    try {
      let read = this.readFile()
      if (read.state === 'corrupt') {
        if (this.setAsideCorrupt() === undefined) return false
        read = { state: 'missing' }
      }
      const file: SecretFile = read.state === 'ok' ? read.file : { version: 1, secrets: {} }
      // 新しい版の形かもしれないファイルには書かない
      if (file.version > 1) return false
      const old = file.secrets[name]
      if (old && !this.canDecrypt(old)) this.keepPrevious(name, old)
      if (value === '') delete file.secrets[name]
      else file.secrets[name] = this.cipher.encrypt(value).toString('base64')
      this.writeJson(this.path, { version: 1, secrets: file.secrets })
      return true
    } catch {
      return false
    }
  }
}

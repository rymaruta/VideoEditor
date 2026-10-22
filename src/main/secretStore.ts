import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'
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
 *   暗号文を `secrets.json.prev` に残す(壊れた .prev は上書きせず .prev.1 …へ)
 * - 読めない(JSON として壊れた・secrets がオブジェクトでない)ファイルは `secrets.json.broken` に移して
 *   残し(既にあれば `.broken.1` …。上書きしない。古いものは新しい5個だけ残す)、画面へ `corrupt` で知らせる
 * - `version` が 1 より新しいファイル(新しい版が作った)は壊れたものと扱わず、読める範囲だけ使い、
 *   移さず書かない(画面へ `fileProblem: 'newer'`)。権限が無いなどの入出力の失敗も壊れたものと分け、
 *   移さず書かない(`fileProblem: 'io'`)
 * - 知らない名前の鍵(新しい版が足したもの)は書き戻すときにそのまま残す
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

type ReadResult =
  { state: 'ok'; file: SecretFile } | { state: 'missing' } | { state: 'corrupt' } | { state: 'io' }

/** 残す .broken の数 */
const KEEP_BROKEN = 5

/** JSON を読む。`missing`・`io`(読めない)・`corrupt`(JSON でない)を分ける */
function readJsonFile(
  path: string
): { state: 'ok'; data: unknown } | { state: 'missing' | 'io' | 'corrupt' } {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? { state: 'missing' } : { state: 'io' }
  }
  try {
    return { state: 'ok', data: JSON.parse(text) as unknown }
  } catch {
    return { state: 'corrupt' }
  }
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

  private readFile(): ReadResult {
    const read = readJsonFile(this.path)
    if (read.state !== 'ok') return { state: read.state }
    const raw = read.data as { version?: unknown; secrets?: unknown } | null
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'corrupt' }
    const version = typeof raw.version === 'number' ? raw.version : 1
    const secretsRaw = raw.secrets ?? {}
    const isObject =
      typeof secretsRaw === 'object' && secretsRaw !== null && !Array.isArray(secretsRaw)
    // 新しい版の形は壊れたものと扱わない(読める範囲だけ使う)
    if (!isObject && version <= 1) return { state: 'corrupt' }
    const secrets: Record<string, string> = {}
    if (isObject)
      for (const [k, v] of Object.entries(secretsRaw as Record<string, unknown>))
        if (typeof v === 'string' && k !== '__proto__') secrets[k] = v
    return { state: 'ok', file: { version, secrets } }
  }

  /** `base` か、それが既にあれば `base.1` `base.2` …のうち、まだ無い名前 */
  private freeName(base: string): string | undefined {
    for (let i = 0; i < 1000; i++) {
      const target = i === 0 ? base : `${base}.${i}`
      if (!existsSync(target)) return target
    }
    return undefined
  }

  /** 壊れたファイルを、上書きしない名前に移す(古い .broken は新しい5個だけ残す)。移した先の名前 */
  private setAsideCorrupt(): string | undefined {
    const target = this.freeName(`${this.path}.broken`)
    if (!target) return undefined
    try {
      renameSync(this.path, target)
    } catch {
      return undefined
    }
    this.pruneBroken()
    return basename(target)
  }

  private pruneBroken(): void {
    try {
      const dir = dirname(this.path)
      const prefix = `${basename(this.path)}.broken`
      const files = readdirSync(dir)
        .filter((f) => f === prefix || /^\.\d+$/.test(f.slice(prefix.length)))
        .filter((f) => f.startsWith(prefix))
        .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t || b.f.localeCompare(a.f, undefined, { numeric: true }))
      for (const { f } of files.slice(KEEP_BROKEN)) unlinkSync(join(dir, f))
    } catch {
      // 片付けられなくても次の機会に
    }
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

  /**
   * 復号できない暗号文を上書きする前に、secrets.json.prev に残す(先に残したものは消さない)。
   * .prev が壊れている・読めないときは上書きせず、.prev.1 …の空いた名前に残す
   */
  private keepPrevious(name: SecretName, enc: string): void {
    const base = `${this.path}.prev`
    for (let i = 0; i < 1000; i++) {
      const target = i === 0 ? base : `${base}.${i}`
      const read = readJsonFile(target)
      if (read.state === 'missing') {
        this.writeJson(target, { version: 1, secrets: { [name]: enc } })
        return
      }
      if (read.state !== 'ok') continue
      const raw = read.data as { secrets?: unknown } | null
      if (!raw || typeof raw.secrets !== 'object' || raw.secrets === null) continue
      const prev = { ...(raw.secrets as Record<string, string>) }
      if (prev[name]) return
      prev[name] = enc
      this.writeJson(target, { version: 1, secrets: prev })
      return
    }
  }

  /** 起動時の状態と、復号できた鍵・読めなかった鍵 */
  load(): SecretsSnapshot {
    const read = this.readFile()
    let corrupt: SecretsSnapshot['corrupt']
    if (read.state === 'corrupt') corrupt = { backup: this.setAsideCorrupt() ?? '' }
    const fileProblem: SecretsSnapshot['fileProblem'] =
      read.state === 'io'
        ? 'io'
        : read.state === 'ok' && read.file.version > 1
          ? 'newer'
          : undefined
    const secrets = read.state === 'ok' ? read.file.secrets : {}
    const stored = SECRET_NAMES.filter((n) => Boolean(secrets[n]))
    const extra = {
      ...(corrupt ? { corrupt } : {}),
      ...(fileProblem ? { fileProblem } : {})
    }
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
        ...extra
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
      ...extra
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
      // 読めない(権限など)ファイルは上書きしない
      if (read.state === 'io') return false
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

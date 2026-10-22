import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { SystemInfo } from '@shared/systemInfo'

/**
 * 不具合の記録(userData/logs/YYYY-MM-DD.log)。未処理の例外・拒否、画面や解析のプロセスが
 * 落ちたことを、日付ごとのファイルに1件ずつ残す。
 *
 * **書くのは「何が・どこで起きたか」だけ。** 素材や企画の中身・API キーは書かない。
 * - 素材のパスは、どの素材で起きたかが分からないと直せないので残す。ただしホームフォルダは `~` に
 *   置き換える(利用者名を出さない)。報告用にまとめるときは、利用者が中身を見てから送る
 *   (自動では送らない)
 * - URL の `key=` などの鍵らしい値・Google の API キーの形(AIza…)は伏せる
 * - 1件は 8,000 字まで、1日のファイルは 2MB まで(同じエラーが続いてディスクを埋めない)
 * - 古いファイルは新しいものから `keepFiles` 個だけ残して消す
 *
 * 書けなくても(ディスクがいっぱい・権限がない)アプリは止めない。
 */

const FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.log$/
const MAX_ENTRY_CHARS = 8000
const MAX_FILE_BYTES = 2 * 1024 * 1024

export interface CrashLogOptions {
  dir: string
  /** 残す日数(ファイルの数)。既定 14 */
  keepFiles?: number
  /** ホームフォルダ(`~` に置き換える) */
  home?: string
  now?: () => Date
}

/** その日のファイルの名前(その PC の日付) */
export function logFileName(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.log`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 記録に書く前に、利用者名・鍵らしい値を伏せる */
export function sanitizeLogText(text: string, home?: string): string {
  let out = text
  if (home && home.length > 1) {
    // Windows はパスの区切りが \ と / のどちらでも来る。大文字小文字も区別しない
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])
    // `/home/al` が `/home/alice` の頭に当たらないよう、区切り・終わりの前だけ
    for (const v of variants)
      out = out.replace(new RegExp(`${escapeRegExp(v)}(?=$|[\\\\/\\s"'():,;])`, 'gim'), '~')
  }
  return (
    out
      // JSON の鍵らしい項目("apiKey": "…"。文字列の中に入った \"token\":\"…\" も)
      .replace(
        new RegExp(
          `(\\\\?"(?:${SECRET_FIELDS})\\\\?"\\s*:\\s*)(\\\\?")(?:[^"\\\\]|\\\\(?!")|\\\\")*?\\2`,
          'gi'
        ),
        '$1$2***$2'
      )
      // URL・設定の書き方の鍵(Gemini の ?key=、Jamendo の client_id=、Freesound の token=、
      // client_secret= / signature= / password= など)
      .replace(new RegExp(`((?:^|[?&\\s;,])(?:${SECRET_PARAMS})=)[^&\\s"',;)]+`, 'gim'), '$1***')
      // Authorization の値(Bearer / Token / Basic の後ろも)
      .replace(
        /(Authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Token|Basic)\s+)?[^\s"',;]+/gi,
        '$1***'
      )
      // 先頭・途中の Bearer トークン
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***')
      // Google の API キーの形
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***')
  )
}

/** JSON で値を伏せる項目の名前(大文字小文字は問わない) */
const SECRET_FIELDS = [
  'authorization',
  '(?:x-)?api[-_]?key',
  '[a-z]*apikey',
  '[a-z]*clientid',
  'client[-_]?id',
  'client[-_]?secret',
  'token',
  'access[-_]?token',
  'refresh[-_]?token',
  'id[-_]?token',
  'secret',
  'password',
  'passwd',
  'signature',
  'key'
].join('|')

/** URL・設定の `名前=値` で値を伏せる名前 */
const SECRET_PARAMS = [
  'key',
  '(?:x-)?api[-_]?key',
  'client[-_]?id',
  'client[-_]?secret',
  'token',
  'access[-_]?token',
  'refresh[-_]?token',
  'signature',
  'sig',
  'password',
  'passwd',
  'secret'
].join('|')

/** 例外・拒否の理由を文字にする(名前・メッセージ・スタックの先頭) */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const stack = (e.stack ?? '').split('\n').slice(1, 16).join('\n')
    const code = (e as NodeJS.ErrnoException).code
    return `${e.name}${code ? ` (${code})` : ''}: ${e.message}${stack ? `\n${stack}` : ''}`
  }
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e) ?? String(e)
  } catch {
    return String(e)
  }
}

export class CrashLog {
  readonly dir: string
  private readonly keepFiles: number
  private readonly home?: string
  private readonly now: () => Date
  private ready = false
  private prunedFor = ''
  /** この起動でファイルの上限に達したことを書いたか(ファイルごと) */
  private readonly capped = new Set<string>()

  constructor(options: CrashLogOptions) {
    this.dir = options.dir
    this.keepFiles = Math.max(1, Math.floor(options.keepFiles ?? 14))
    this.home = options.home
    this.now = options.now ?? (() => new Date())
  }

  /** 1件書く。`source` は main / renderer / process など、`kind` は何が起きたか */
  write(source: string, kind: string, detail?: unknown): void {
    try {
      if (!this.ready) {
        mkdirSync(this.dir, { recursive: true })
        this.ready = true
      }
      const date = this.now()
      const name = logFileName(date)
      const path = join(this.dir, name)
      let size = 0
      try {
        size = statSync(path).size
      } catch {
        size = 0
      }
      if (size >= MAX_FILE_BYTES) {
        if (!this.capped.has(name)) {
          this.capped.add(name)
          appendFileSync(
            path,
            `${date.toISOString()} [log] この日の記録が上限に達したので、以降は省きます\n`
          )
        }
        return
      }
      let body = detail === undefined ? '' : describeError(detail)
      body = sanitizeLogText(body, this.home)
      if (body.length > MAX_ENTRY_CHARS) body = `${body.slice(0, MAX_ENTRY_CHARS)}…(省略)`
      const head = sanitizeLogText(`${date.toISOString()} [${source}] ${kind}`, this.home)
      const entry = body ? `${head}\n${indent(body)}\n` : `${head}\n`
      appendFileSync(path, entry)
      // 起動して最初の1件と、日が替わったとき(長く開いたまま)に古いものを片付ける。
      // 今日のファイルを作った後に数える(先に数えると1つ多く残る)
      if (this.prunedFor !== name) {
        this.prunedFor = name
        this.prune()
      }
    } catch {
      // 記録できなくても、アプリは続ける
    }
  }

  /** 記録のファイル(新しい順) */
  files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => FILE_PATTERN.test(f))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  /** 新しいものから `keepFiles` 個を残して消す。ほかのファイル(利用者が置いたもの)は触らない */
  prune(): void {
    for (const f of this.files().slice(this.keepFiles)) {
      try {
        unlinkSync(join(this.dir, f))
      } catch {
        // 消せなくても次の機会に
      }
    }
  }

  /** 直近の記録(新しいファイルから `maxBytes` まで。古い順に並べ直して返す) */
  recent(maxBytes = 200 * 1024): string {
    const parts: string[] = []
    let total = 0
    for (const f of this.files()) {
      if (total >= maxBytes) break
      let text = ''
      try {
        text = readFileSync(join(this.dir, f), 'utf-8')
      } catch {
        continue
      }
      const room = maxBytes - total
      if (text.length > room) text = `…(前を省略)\n${text.slice(text.length - room)}`
      parts.push(`----- ${f} -----\n${text}`)
      total += text.length
    }
    return parts.reverse().join('\n')
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
}

/** 決まった時間に決まった数まで通す(画面から同じエラーが続けて届いても記録を埋めない) */
export class RateLimiter {
  private stamps: number[] = []
  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  take(now = Date.now()): boolean {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs)
    if (this.stamps.length >= this.max) return false
    this.stamps.push(now)
    return true
  }
}

/** 報告用の文書(版・OS・GPU・直近の記録)。中身は利用者が読める文字だけ */
export function buildBugReport(
  info: SystemInfo,
  extra: { productName: string; version: string; versions: Record<string, string | undefined> },
  recentLog: string,
  freeMemoryGb: number,
  gpuFeatures: Record<string, string>,
  home?: string,
  now = new Date()
): string {
  const lines = [
    `${extra.productName} 不具合の報告用の情報`,
    `作成: ${now.toISOString()}`,
    '',
    'このファイルはどこにも自動では送られません。送る前に中身を確かめてください。',
    '記録には、使っていた素材のファイルの場所が含まれることがあります(ホームフォルダは ~ に置き換えています)。',
    '素材・企画の中身や API キーは含みません。',
    '',
    '[版]',
    `  ${extra.productName} ${extra.version}`,
    `  Electron ${extra.versions.electron ?? '?'} / Chromium ${extra.versions.chrome ?? '?'} / Node.js ${extra.versions.node ?? '?'}`,
    '',
    '[PC]',
    `  OS: ${info.os}`,
    `  CPU: ${info.cpu}(${info.cores} スレッド)`,
    `  メモリ: ${info.memoryGb} GB(空き ${freeMemoryGb.toFixed(1)} GB)`,
    '',
    '[GPU]',
    ...(info.gpu.length > 0 ? info.gpu.map((g) => `  ${g}`) : ['  (取得できませんでした)']),
    ...Object.entries(gpuFeatures).map(([k, v]) => `  ${k}: ${v}`),
    '',
    '[直近の記録]',
    recentLog.trim() || '  (記録はありません)',
    ''
  ]
  return sanitizeLogText(lines.join('\n'), home)
}

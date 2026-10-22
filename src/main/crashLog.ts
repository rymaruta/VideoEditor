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

/**
 * 記録に書く前に、利用者名・鍵らしい値を伏せる。
 *
 * - ホームフォルダ → `~`
 * - `名前: 値` の形(JSON・JS のオブジェクト・HTTP のヘッダ。名前はクォートなし・'…'・"…"・
 *   文字列に入った \"…\" のどれも)で、名前が鍵らしいもの(apiKey・x-goog-api-key・sessionToken・
 *   client_secret・password・Authorization・Cookie など。前に何が付いてもよい)の値
 * - `名前=値` の形(URL の ?key= / #access_token=、%3D で符号化されたもの、環境変数の
 *   GEMINI_API_KEY=… など)
 * - Bearer の後ろ、JWT・Google の API キー(AIza…)・OAuth(ya29.…)・sk-…・ghp_… の形
 *
 * 正規表現は入れ子の繰り返しを使わず、値の終わりは手で数える(長い入力でも時間が伸びない)。
 */
export function sanitizeLogText(text: string, home?: string): string {
  let out = text
  if (home && home.length > 1) {
    // Windows はパスの区切りが \ と / のどちらでも来る。大文字小文字も区別しない
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])
    // `/home/al` が `/home/alice` の頭に当たらないよう、区切り・終わりの前だけ
    for (const v of variants)
      out = out.replace(new RegExp(`${escapeRegExp(v)}(?=$|[\\\\/\\s"'():,;#])`, 'gim'), '~')
  }
  out = redactNamedValues(out)
  return (
    out
      // `名前=値`(URL・フォーム・環境変数)
      .replace(PARAM_PATTERN, '$1***')
      // Bearer の後ろ
      .replace(/\bbearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
      // 鍵の形
      .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, 'eyJ***')
      .replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
      .replace(/\bya29\.[A-Za-z0-9_-]+/g, 'ya29.***')
      .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, 'sk-***')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_***')
  )
}

/** 値を伏せる名前(この前に何が付いてもよい: GEMINI_API_KEY・sessionToken・X-Goog-Api-Key など) */
const SECRET_NAME = [
  'api[-_]?key',
  'key',
  'client[-_]?id',
  'client[-_]?secret',
  'token',
  'secret',
  'password',
  'passwd',
  'signature',
  'sig',
  'credentials?',
  'authorization',
  'cookie'
].join('|')

/** `名前: 値` の名前の部分(この後ろから値を手で読む) */
const NAMED_VALUE = new RegExp(
  `(?<![A-Za-z0-9_$-])(\\\\*["']?)[A-Za-z0-9_$-]*?(?:${SECRET_NAME})\\1[ \\t]*:[ \\t]*`,
  'gi'
)

/** `名前=値`。区切りの後(URL の ? & # / ; 、%3F %26、空白・行頭など)の名前だけ */
const PARAM_PATTERN = new RegExp(
  `((?:^|[?&\\s;,/#(:"'\\[{]|%3F|%26)[A-Za-z0-9_-]*?(?:${SECRET_NAME})(?:=|%3D)["']?)(?:(?!%26)[^&\\s"',;)#])+`,
  'gim'
)

/** 値の終わり(`start` は値の始まり)。クォートで囲まれていればその終わりまで、なければ区切りまで */
function valueEnd(s: string, start: number, name: string): { end: number; quote: string } {
  let i = start
  while (s[i] === '\\') i++
  const q = s[i]
  if (q === '"' || q === "'") {
    const depth = i - start
    // 同じ深さのクォート(前の \ の数が同じもの)で終わる。それより多い \ の付いたものは中身
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] !== q) continue
      let k = 0
      while (j - 1 - k > i && s[j - 1 - k] === '\\') k++
      if (k === depth) return { end: j + 1, quote: s.slice(start, i + 1) }
    }
    return { end: s.length, quote: s.slice(start, i + 1) }
  }
  if (i > start) return { end: start, quote: '' }
  // Cookie は行の終わりまで(SID=…; HSID=… と続く)
  if (/cookie$/i.test(name)) {
    const nl = s.indexOf('\n', start)
    return { end: nl < 0 ? s.length : nl, quote: '' }
  }
  let j = start
  // Authorization: Bearer / Token / Basic の後ろの値まで
  const scheme = /^(?:bearer|token|basic|digest)[ \t]+/i.exec(s.slice(start, start + 16))
  if (scheme) j += scheme[0].length
  while (j < s.length && !/[\s,;}\])"']/.test(s[j])) j++
  return { end: j, quote: '' }
}

function redactNamedValues(s: string): string {
  const parts: string[] = []
  let last = 0
  NAMED_VALUE.lastIndex = 0
  for (let m = NAMED_VALUE.exec(s); m; m = NAMED_VALUE.exec(s)) {
    const start = m.index + m[0].length
    const name = m[0].replace(/[\\"'\s:]/g, '')
    const { end, quote } = valueEnd(s, start, name)
    if (end <= start) continue
    parts.push(s.slice(last, start), quote ? `${quote}***${quote}` : '***')
    last = end
    NAMED_VALUE.lastIndex = Math.max(end, NAMED_VALUE.lastIndex)
  }
  parts.push(s.slice(last))
  return parts.join('')
}

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

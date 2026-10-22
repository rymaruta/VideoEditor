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

/** 伏せ字にかける長さの上限(これより長い入力は先に切る。記録の1件は 8,000 字までなので足りる) */
export const MAX_SANITIZE_CHARS = 64 * 1024

/**
 * 記録に書く前に、利用者名・鍵らしい値を伏せる。
 *
 * - ホームフォルダ → `~`
 * - 鍵らしい名前の後の値。名前は語に分けた最後の語(数字・v2 などの版は除く)が
 *   (api)key・token・secret・password・passwd・credential(s)・authorization・cookie で終わるもの、
 *   または client id・signature(GEMINI_API_KEY・GEMINIAPIKEY・accesstoken・authtoken・clientsecret・
 *   secretkey・sessionToken・x-goog-api-key・apiKeys・ACCESS_TOKEN_V2 は当たる)。hotkey・monkey・
 *   turkey・shortcutKey・publicKey・sortKey・primaryKey・tokens・keyframes、「cache key:」のように
 *   前に語のある key は当てない。
 *   名前と値の間は `:` `=`(全角も) `%3D` `=>`、タブ、クォートした名前なら `,`。名前・値のクォートは
 *   なし・'…'・"…"・文字列に入った \"…\"(何重でも)のどれも
 * - none・null・true・false・(none) などの値はそのまま。値が { や [ で始まるもの(オブジェクト・配列)は
 *   中の項目に任せる。Cookie は値全体(行の終わりまで)で判断する
 * - Bearer の後ろ、URL の user:password@、PEM の秘密鍵、JWT・Google の API キー(AIza…)・ya29.…・
 *   sk-…・ghp_… の形
 *
 * 入れ子の繰り返し・後戻りのある正規表現を使わず(連なりの途中から始めない)、名前の切り出しと値の
 * 終わりは手で数える(長い入力でも時間が伸びない)。`MAX_SANITIZE_CHARS` を超える入力は先に切る
 * (`maxChars` で変えられる。報告のまとめは全体で伏せる)。
 */
export function sanitizeLogText(
  text: string,
  home?: string,
  options: { maxChars?: number } = {}
): string {
  const max = options.maxChars ?? MAX_SANITIZE_CHARS
  let out = text.length > max ? `${text.slice(0, max)}…(省略)` : text
  if (home && home.length > 1) {
    // Windows はパスの区切りが \ と / のどちらでも来る。大文字小文字も区別しない
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])
    // `/home/al` が `/home/alice` の頭に当たらないよう、区切り・終わりの前だけ
    for (const v of variants)
      out = out.replace(new RegExp(`${escapeRegExp(v)}(?=$|[\\\\/\\s"'():,;#])`, 'gim'), '~')
  }
  // PEM の秘密鍵(名前: 値 より先に。値の頭の -----BEGIN だけ伏せて中身が残らないように)
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[^\n]*/g, '-----BEGIN PRIVATE KEY-----***')
  out = redactNamedValues(out)
  return (
    out
      // URL の user:password@(scheme は連なりの頭からだけ見る。// で始まるものも)
      // パスワードの長さに上限を付ける(// が続くと空白まで読み直して二乗になった。5回目の監査)
      .replace(/((?<![a-z0-9+.-])(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s:/@]+:)[^\s@]{1,256}@/gi, '$1***@')
      // Bearer の後ろ
      .replace(/\bbearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
      // 鍵の形(連なりの頭からだけ見る)
      .replace(
        /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
        'eyJ***'
      )
      .replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
      .replace(/\bya29\.[A-Za-z0-9_-]+/g, 'ya29.***')
      .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, 'sk-***')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_***')
  )
}

/** 名前を語に分ける(_ - . $ と、小文字→大文字・大文字の連なり→大文字+小文字の境目) */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.$-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

/** 最後の語がこれで終われば鍵らしい(続け書きの GEMINIAPIKEY・accesstoken・clientsecret も) */
const SECRET_SUFFIX =
  /(?:apikeys|key|token|secret|password|passwd|credentials?|authorization|cookie)$/

/** 鍵らしく見えて鍵ではない名前(続けた形で比べる) */
const NOT_SECRET = new Set([
  'hotkey',
  'monkey',
  'turkey',
  'donkey',
  'whiskey',
  'jockey',
  'hockey',
  'shortcutkey',
  'publickey',
  'sortkey',
  'primarykey',
  'foreignkey',
  'cachekey',
  'reactkey',
  'storagekey'
])

/** 名前が鍵らしいか。`sig` は `sig=`(URL の署名)のときだけ */
function secretName(name: string, sep: string): boolean {
  const words = nameWords(name)
  // 後ろの版・番号(ACCESS_TOKEN_V2・apiKey2)は外して見る
  while (words.length > 1 && /^(?:v?\d+)$/.test(words[words.length - 1])) words.pop()
  let last = words[words.length - 1]
  if (!last) return false
  // 語の後ろの番号(apiKey2)も外す
  last = last.replace(/\d+$/, '')
  const joined = words.join('')
  if (NOT_SECRET.has(joined) || NOT_SECRET.has(words.slice(-2).join(''))) return false
  if (SECRET_SUFFIX.test(last)) return !NOT_SECRET.has(last)
  if (last === 'keys' && words[words.length - 2] === 'api') return true
  if (last === 'id' && words[words.length - 2] === 'client') return true
  if (last === 'clientid' || last === 'signature') return true
  if (last === 'sig' && sep === '=') return true
  return false
}

/** 値として伏せないもの(鍵ではないと分かるもの) */
const PLACEHOLDER = /^(?:none|null|undefined|true|false|n\/a|-+|\(none\)|\(null\)|\[\]|\{\})$/i

const IDENT = /[A-Za-z0-9_$][A-Za-z0-9_$.-]*/g

/** 名前と値の間の空白(タブ・NBSP・全角の空白も) */
const isBlank = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\u00a0' || c === '\u3000'

/** `s[pos]` から始まる区切り(名前と値の間)を読む。無ければ null */
function readSeparator(
  s: string,
  pos: number,
  quoted: boolean
): { sep: string; next: number } | null {
  let i = pos
  while (isBlank(s[i])) i++
  const ch = s[i]
  // 全角のコロン(U+FF1A)・等号(U+FF1D)も区切りとみる
  if (ch === ':' || ch === '\uFF1A') return { sep: ':', next: i + 1 }
  if (ch === '=' && s[i + 1] === '>') return { sep: '=>', next: i + 2 }
  if (ch === '=' || ch === '\uFF1D') return { sep: '=', next: i + 1 }
  if (ch === '%' && s.slice(i, i + 3).toUpperCase() === '%3D') return { sep: '=', next: i + 3 }
  if (ch === ',' && quoted) return { sep: ',', next: i + 1 }
  // タブだけで区切ったもの(apiKey<TAB>値)
  if (i > pos && s.slice(pos, i).includes('\t') && ch !== undefined && !/[\s,;)}\]]/.test(ch))
    return { sep: '\t', next: i }
  return null
}

/** 値の終わり(`start` は値の始まり)。クォートで囲まれていればその終わりまで、なければ区切りまで */
function valueEnd(
  s: string,
  start: number,
  sep: string,
  cookie: boolean
): { end: number; quote: string } {
  let i = start
  while (s[i] === '\\') i++
  const q = s[i]
  if (q === '"' || q === "'" || q === '`') {
    const depth = i - start
    // 同じ深さのクォート(前の \ の数が同じもの)で終わる。それより多い \ の付いたものは中身
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] !== q) continue
      let k = 0
      while (k <= depth && j - 1 - k > i && s[j - 1 - k] === '\\') k++
      if (k === depth) return { end: j + 1, quote: s.slice(start, i + 1) }
    }
    return { end: s.length, quote: s.slice(start, i + 1) }
  }
  // Cookie は値全体(行の終わりまで。SID=…; HSID=… と続く)
  if (cookie) {
    const nl = s.indexOf('\n', start)
    return { end: nl < 0 ? s.length : nl, quote: '' }
  }
  // (…) は閉じかっこまでを1つの値とみる(「(none)」を残し、「(鍵)」は伏せる)
  if (s[start] === '(') {
    const close = s.indexOf(')', start)
    const nl = s.indexOf('\n', start)
    if (close > 0 && (nl < 0 || close < nl)) return { end: close + 1, quote: '' }
  }
  // URL・フォーム・環境変数の値: & # 空白・クォート・閉じかっこ・%26 で終わる
  if (sep === '=') {
    let j = start
    while (j < s.length && !/[&\s"',;)#>`|\]}]/.test(s[j])) {
      if (s[j] === '%' && s.slice(j, j + 3).toUpperCase() === '%26') break
      j++
    }
    return { end: j, quote: '' }
  }
  let j = start
  // Authorization: Bearer / Token / Basic の後ろの値まで
  const scheme = /^(?:bearer|token|basic|digest)[ \t]+/i.exec(s.slice(start, start + 16))
  if (scheme) j += scheme[0].length
  while (j < s.length && !/[\s,;}\])"'`>]/.test(s[j])) j++
  return { end: j, quote: '' }
}

/**
 * 値が { [ で始まるとき: 中に項目があれば(オブジェクト・配列)`container`、項目の無いかっこ({鍵} [鍵])
 * なら閉じかっこの次の位置、どちらでもなければ null
 */
function bracketValue(s: string, start: number): 'container' | number | null {
  const open = s[start]
  if (open !== '{' && open !== '[') return null
  const close = open === '{' ? '}' : ']'
  let i = start + 1
  while (isBlank(s[i]) || s[i] === '\n' || s[i] === '\r') i++
  if (/["'{[\\]/.test(s[i] ?? '')) return 'container'
  // 行の中で、閉じかっこより先に : , があれば項目とみる
  for (let j = i; j < s.length && j < start + 256; j++) {
    const c = s[j]
    if (c === '\n') return 'container'
    if (c === ':' || c === ',' || c === '=') return 'container'
    if (c === close) return j + 1
  }
  return 'container'
}

function redactNamedValues(s: string): string {
  const parts: string[] = []
  let last = 0
  IDENT.lastIndex = 0
  for (let m = IDENT.exec(s); m; m = IDENT.exec(s)) {
    const identStart = m.index
    let name = m[0]
    // %3F・%26 などで符号化された区切りの後ろ(%3Fkey)
    if (identStart > 0 && s[identStart - 1] === '%' && /^[0-9A-Fa-f]{2}./.test(name))
      name = name.slice(2)
    // 後ろの . - を外す(連なりは長いことがあるので、後ろから手で数える)
    let cut = name.length
    while (cut > 0 && (name[cut - 1] === '.' || name[cut - 1] === '-')) cut--
    name = name.slice(0, cut)
    if (!name) continue
    let after = identStart + m[0].length
    // 名前のクォート(前の \ と ' " の並び)が後ろにも同じだけあれば、クォートした名前
    let qs = identStart
    if (s[qs - 1] === '"' || s[qs - 1] === "'") {
      qs--
      while (qs > 0 && s[qs - 1] === '\\') qs--
    }
    const openQuote = s.slice(qs, identStart)
    const quoted = openQuote.length > 0 && s.startsWith(openQuote, after)
    if (quoted) after += openQuote.length
    const sep = readSeparator(s, after, quoted)
    if (!sep || !secretName(name, sep.sep)) continue
    const words = nameWords(name)
    // 「cache key:」「React key:」のように、前に語のある単独の key は名前ではなく文の一部
    if (
      !quoted &&
      words.length === 1 &&
      words[0] === 'key' &&
      sep.sep === ':' &&
      isBlank(s[identStart - 1]) &&
      /[A-Za-z]/.test(s[identStart - 2] ?? '')
    )
      continue
    let start = sep.next
    while (isBlank(s[start])) start++
    // 「名前:」「名前=」の後が改行なら、次の行(空の行は飛ばす)の頭を値とみる(apiKey:\n値)
    for (let n = 0; n < 3 && (s[start] === '\n' || s[start] === '\r'); n++) {
      start += s[start] === '\r' && s[start + 1] === '\n' ? 2 : 1
      while (isBlank(s[start])) start++
    }
    // 値がオブジェクト・配列なら、中の項目に任せる({"credentials":{"private_key":"…"}} の形を崩さない)。
    // {鍵} [鍵] のように中に項目の無いかっこは、閉じかっこまでを1つの値とみる
    const bracket = bracketValue(s, start)
    if (bracket === 'container') continue
    const joined = words.join('-')
    // Cookie を行の終わりまで見るのは、ヘッダの形(名前にクォートが無い)だけ
    const cookie = !quoted && sep.sep === ':' && (joined === 'cookie' || joined === 'set-cookie')
    const { end, quote } =
      typeof bracket === 'number'
        ? { end: bracket, quote: '' }
        : valueEnd(s, start, sep.sep, cookie)
    if (end <= start) continue
    const raw = s.slice(start, end)
    const inner = quote ? raw.slice(quote.length, raw.length - quote.length) : raw
    if (!quote && PLACEHOLDER.test(inner.trim())) continue
    if (quote && inner === '') continue
    parts.push(s.slice(last, start), quote ? `${quote}***${quote}` : '***')
    last = end
    IDENT.lastIndex = Math.max(end, IDENT.lastIndex)
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
  // 全体で伏せる(名前と値が行をまたぐ apiKey:\n値 も拾う)。伏せ字は長さに比例する時間で済むので、
  // 直近の記録(数百 KB)でも長さの上限で切らない
  return sanitizeLogText(lines.join('\n'), home, { maxChars: Number.POSITIVE_INFINITY })
}

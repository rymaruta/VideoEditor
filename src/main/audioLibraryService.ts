import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import https from 'https'
import http from 'http'
import { probeMedia } from './ffmpegService'

const MAX_REDIRECTS = 5
const DOWNLOAD_TIMEOUT_MS = 30000

function download(url: string, destPath: string, redirectsLeft = MAX_REDIRECTS): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https
    const req = client.get(url, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) {
          reject(new Error('リダイレクトが多すぎます'))
          return
        }
        download(new URL(res.headers.location, url).toString(), destPath, redirectsLeft - 1)
          .then(resolve)
          .catch(reject)
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        reject(new Error(`ダウンロードに失敗しました (HTTP ${status})`))
        return
      }
      const fileStream = createWriteStream(destPath)
      res.pipe(fileStream)
      fileStream.on('finish', () => fileStream.close(() => resolve()))
      fileStream.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error('ダウンロードがタイムアウトしました'))
    })
  })
}

/** 原因が分からないときに残す長さの上限。これ以上出しても読めない。 */
const MAX_DETAIL_LENGTH = 120

/**
 * 見慣れた原因は、その場で何をすればよいか分かる日本語に置き換える。
 * **判定は英文ではなくエラーコード**で行う——Node の文言が変わった日から
 * 黙って未知扱いに戻るのを避けるため(`httpJson` の判定と同じ考え方)。
 */
const KNOWN_CODES: [RegExp, string][] = [
  [
    /^(ENOTFOUND|EAI_AGAIN)$/,
    '音源の配信元が見つかりませんでした。インターネット接続を確認して、もう一度お試しください。'
  ],
  [
    /^(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENETDOWN)$/,
    '音源の配信元に接続できませんでした。インターネット接続を確認して、もう一度お試しください。'
  ],
  [/^(ECONNRESET|EPIPE)$/, '通信が途中で切れました。もう一度お試しください。'],
  [
    /^(ETIMEDOUT|ESOCKETTIMEDOUT)$/,
    '接続がタイムアウトしました。回線の状態を確かめて、もう一度お試しください。'
  ],
  [/^ENOSPC$/, 'ディスクの空き容量が足りません'],
  [/^(EACCES|EPERM|EROFS)$/, '保存先に書き込む権限がありません'],
  [
    /CERT|SSL|TLS/,
    '音源の配信元の証明書を確認できませんでした。時計の設定とネットワークの設定を確認してください。'
  ]
]

/**
 * ダウンロードの失敗を、利用者に見せられる短い日本語にする。
 *
 * `http.get` / 書き込みストリームが投げるのは **Node の生のシステムエラー**で、
 * `connect ECONNREFUSED 127.0.0.1:443` や `getaddrinfo ENOTFOUND …` がそのまま
 * 画面に出ていた。**何が起きたのかも、次に何をすればよいかも分からない。**
 * 同じパネルの中でも、検索の失敗は `httpJson` を通って日本語になっているので、
 * **押すボタンによって英語と日本語が混ざる**という形で出る。
 * (実測: BGM を検索して「音声トラックに追加」を押すと、圏外相当で
 *  **`getaddrinfo ENOTFOUND no-such-host-xyz.invalid`(46文字・日本語なし)**、
 *  配信元が落ちていれば **`connect ECONNREFUSED 127.0.0.1:9`(32文字)**)
 *
 * **こちらが投げた日本語は素通しにする。** HTTPステータス・タイムアウト・
 * リダイレクト過多はこの関数の外で既に日本語になっており、`probeMedia` の失敗も
 * `describeFfmpegError` を通った後。見分けは `code` の有無で付く——
 * Node のシステムエラーだけが `code` を持ち、こちらの `new Error(日本語)` は持たない。
 *
 * 見慣れない原因は**捨てずに**、1行にして長さで切って残す(唯一の手がかりになる)。
 */
function describeDownloadFailure(e: unknown): Error {
  const code =
    typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : ''
  if (!code) return e instanceof Error ? e : new Error(String(e))
  for (const [pattern, message] of KNOWN_CODES) {
    if (pattern.test(code)) return new Error(message)
  }
  const raw = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim()
  const detail = raw.length > MAX_DETAIL_LENGTH ? `${raw.slice(0, MAX_DETAIL_LENGTH)}…` : raw
  return new Error(`音源を取得できませんでした: ${detail}`)
}

/**
 * ファイル名の1要素に使える上限。**バイト数で効く**(ext4 などの `NAME_MAX` は 255)。
 * パス全体の上限とは別物で、フォルダがどれだけ浅くても関係なく当たる。
 */
const MAX_FILE_NAME_BYTES = 255
/**
 * 名前の部分に許す文字数。今までと同じ値で、日本語の曲名でも見出しとして読める長さ。
 * バイト上限だけにすると半角の名前が 200文字超まで伸びて、Windows の
 * パス長(260文字)に別口で当たりうるので、**文字数の上限も残す**。
 */
const MAX_FILE_NAME_CHARS = 80

/**
 * ファイル名の一部に埋める文字列を、**文字数とバイト数の両方**で切り詰める。
 *
 * `slice(0, 80)` は**文字数しか見ない**。日本語は1文字3バイトなので 240バイトまで通り、
 * UUID と拡張子を足した時点で 255バイトを超えて `ENAMETOOLONG` になる——
 * 曲名を長くしただけで、ダウンロードは始まったのに書き込みで落ちる。
 * (実測: `${UUID}-${曲名}.mp3` の形で、日本語 **71文字(254バイト)までは書けて、
 *  72文字(257バイト)から `ENAMETOOLONG`**。同じフォルダへ 255バイトちょうどの名前を
 *  直に書けば通るので、超えているぶんがそのまま原因)
 *
 * 切る単位は**コードポイント**にする。`slice` は UTF-16 の符号単位で切るので
 * **サロゲートペアを半分に割り**、絵文字入りの曲名から壊れた文字が残る。
 */
function truncateFileNamePart(name: string, maxBytes: number): string {
  // NaN との比較は必ず false なので、素で書くと**上限が無いのと同じ**になる
  // (「切り詰めたつもり」で全部通る側へ落ちる)。数でないなら何も通さない。
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return ''
  let bytes = 0
  let chars = 0
  let out = ''
  for (const ch of name) {
    if (chars >= MAX_FILE_NAME_CHARS) break
    const size = Buffer.byteLength(ch)
    if (bytes + size > maxBytes) break
    bytes += size
    chars += 1
    out += ch
  }
  return out
}

function sanitizeFileName(name: string, maxBytes: number): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  // 切った末尾に空白が残ることがある。Windows は末尾の空白を黙って落とすので揃えておく
  return truncateFileNamePart(cleaned, maxBytes).trim() || 'audio'
}

function extensionFromUrl(url: string): string {
  const match = /\.(mp3|wav|ogg|m4a|flac)(?:\?|$)/i.exec(url)
  return match ? match[1].toLowerCase() : 'mp3'
}

export async function downloadAudioAsset(
  url: string,
  suggestedName: string
): Promise<{ filePath: string; duration: number }> {
  const dir = join(app.getPath('userData'), 'audio-library')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const ext = extensionFromUrl(url)
  // 曲名に使えるバイト数は、**先に決まっているぶんを引いた残り**。
  // UUID(36バイト)と区切りの `-`、それに `.${拡張子}` は動かせない。
  const prefix = `${randomUUID()}-`
  const suffix = `.${ext}`
  const nameBudget = MAX_FILE_NAME_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)
  const filePath = join(dir, `${prefix}${sanitizeFileName(suggestedName, nameBudget)}${suffix}`)
  try {
    await download(url, filePath)
    const meta = await probeMedia(filePath)
    return { filePath, duration: meta.duration }
  } catch (e) {
    // A dropped connection or an undecodable download would otherwise leave a
    // partial file in userData forever — each retry adding another orphan.
    // **後始末で投げないこと。** `force: true` でも「消せない」以外の失敗
    // (長すぎるパスの `lstat` など)は投げるので、そのまま書くと**本当の原因が
    // 後始末の失敗にすり替わって外へ出る**。実測: 名前が500文字だと
    // `ENAMETOOLONG: name too long, lstat '/…'`(生の英語・パス付き)が出て、
    // 実際の原因(接続できなかったこと)はどこにも残らなかった。
    try {
      rmSync(filePath, { force: true })
    } catch {
      /* 消せなくても、報告すべきは元の失敗のほう */
    }
    // 直すのは**読む側のここ1箇所**。試聴・追加・お気に入りの3ボタンはどれも
    // この関数を通るので、呼び出し元ごとに try/catch を足さない。
    throw describeDownloadFailure(e)
  }
}

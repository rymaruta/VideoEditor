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

function sanitizeFileName(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim()
      .slice(0, 80) || 'audio'
  )
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
  const filePath = join(dir, `${randomUUID()}-${sanitizeFileName(suggestedName)}.${ext}`)
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

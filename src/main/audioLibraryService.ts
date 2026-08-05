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
    rmSync(filePath, { force: true })
    throw e
  }
}

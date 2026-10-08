import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { contentFingerprint } from './fileFingerprint'
import { ENVELOPE_RATE, EnvelopeBuilder } from '@shared/sync/correlate'

/**
 * 素材の音を ffmpeg で読む部品。同期・話者の判定・音声認識で共有する
 * (どれも別スレッドからも呼ぶので、electron に依存しない)。
 */

export const ENVELOPE_SAMPLE_RATE = 8000

export interface AudioFileRef {
  path: string
  size: number
  mtimeMs: number
}

export function readPcm(
  ffmpegPath: string,
  args: string[],
  onChunk: (samples: Float32Array) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', ...args], {
      windowsHide: true
    })
    let rest: Buffer = Buffer.alloc(0)
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => {
      const buf = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk
      const usable = buf.length - (buf.length % 4)
      if (usable > 0) {
        // Buffer の位置が4の倍数とは限らないので、写してから float として読む
        const copy = new Float32Array(usable / 4)
        Buffer.from(copy.buffer).set(buf.subarray(0, usable))
        onChunk(copy)
      }
      rest = buf.subarray(usable)
    })
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 4000) err += c.toString()
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg ${code}`))
    )
  })
}

function envelopeCachePath(cacheDir: string, f: AudioFileRef): string {
  const key = createHash('sha1')
    .update(
      `${f.path}|${f.size}|${f.mtimeMs}|${contentFingerprint(f.path)}|${ENVELOPE_SAMPLE_RATE}|${ENVELOPE_RATE}`
    )
    .digest('hex')
  return join(cacheDir, `${key}.env`)
}

/**
 * キャッシュの包絡線を読む。壊れている(4 バイトの倍数でない・空)なら消して null
 * (途中で落ちた書き込みの残りを、そのまま使い続けて同期が毎回失敗していた)
 */
function readCachedEnvelope(cached: string): Float32Array | null {
  try {
    const buf = readFileSync(cached)
    if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) {
      rmSync(cached, { force: true })
      return null
    }
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  } catch {
    return null
  }
}

/** 10ms ごとの音の大きさ(包絡線)。一度作ったものはキャッシュから読む */
export async function cachedEnvelope(
  ffmpegPath: string,
  cacheDir: string,
  f: AudioFileRef
): Promise<Float32Array> {
  const cached = envelopeCachePath(cacheDir, f)
  if (existsSync(cached)) {
    const env = readCachedEnvelope(cached)
    if (env) return env
  }
  const builder = new EnvelopeBuilder(ENVELOPE_SAMPLE_RATE)
  await readPcm(
    ffmpegPath,
    ['-i', f.path, '-vn', '-ac', '1', '-ar', String(ENVELOPE_SAMPLE_RATE), '-f', 'f32le', 'pipe:1'],
    (s) => builder.push(s)
  )
  const env = builder.finish()
  try {
    mkdirSync(cacheDir, { recursive: true })
    // 別の名前に書いてから名前を替える(書いている途中の物を、別のスレッドが読まないように)
    const tmp = `${cached}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(tmp, Buffer.from(env.buffer, env.byteOffset, env.byteLength))
    try {
      renameSync(tmp, cached)
    } catch {
      rmSync(tmp, { force: true })
    }
  } catch {
    // キャッシュに書けなくても続けられる
  }
  return env
}

/** start 秒から length 秒の波形(モノラル)。素材の外にはみ出した分は無音で埋める */
export async function readWindow(
  ffmpegPath: string,
  path: string,
  start: number,
  length: number,
  sampleRate: number
): Promise<Float32Array> {
  const total = Math.round(length * sampleRate)
  const out = new Float32Array(total)
  const lead = Math.min(total, Math.max(0, Math.round(-start * sampleRate)))
  if (lead >= total) return out
  let pos = lead
  await readPcm(
    ffmpegPath,
    [
      '-ss',
      Math.max(0, start).toFixed(4),
      '-t',
      (length - lead / sampleRate).toFixed(4),
      '-i',
      path,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      'f32le',
      'pipe:1'
    ],
    (s) => {
      const n = Math.min(s.length, total - pos)
      if (n > 0) out.set(s.subarray(0, n), pos)
      pos += Math.max(0, n)
    }
  )
  return out
}

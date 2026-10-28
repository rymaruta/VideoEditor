import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { contentFingerprint } from './fileFingerprint'
import { describeFfmpegExit } from './ffmpegError'
import { stopNow, trackUntilDone } from './liveProcesses'
import { ENVELOPE_RATE, EnvelopeBuilder, SYNC_BAND_HZ } from '@shared/sync/correlate'

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

/** `signal` で止めたときの失敗(呼ぶ側は「止めた」と見分けて黙って捨てる) */
export const PCM_ABORTED = 'PCM_ABORTED'

export function readPcm(
  ffmpegPath: string,
  args: string[],
  onChunk: (samples: Float32Array) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(PCM_ABORTED))
      return
    }
    // アプリを閉じるときに止める一覧に入れる(閉じた後も 3 時間の素材を読み続けないように)
    const child = trackUntilDone(
      spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', ...args], {
        windowsHide: true
      })
    )
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      try {
        stopNow(child)
      } catch {
        // すでに終わっている
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('close', () => signal?.removeEventListener('abort', onAbort))
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
    // 失敗は利用者に見せられる日本語にする(ffmpeg の最後の英語の1行がそのまま工程の失敗に出ていた)
    child.on('close', (code) => {
      if (aborted) reject(new Error(PCM_ABORTED))
      else if (code === 0) resolve()
      else reject(describeFfmpegExit(code, err))
    })
  })
}

/**
 * 音声の頭を素材の時刻 0 にそろえる(書き出しの `ALIGN_AUDIO_START` と同じ)。音声が映像より遅れて
 * 始まる素材(start_time が 0 でない)は、そのまま読むと遅れの分が詰まり、同期・文字起こしが
 * 書き出し・プレビューと遅れの分だけずれていた(330ms 遅れたカメラが 330ms ずれて置かれ、
 * 時計のずれも測れなかった)。`-ss` で頭から読んでも、始まる前の分を無音で埋める
 */
export const PCM_ALIGN_FILTER = 'aresample=async=1:first_pts=0'

/** 包絡線のキャッシュの形が変わったら上げる(古い形のキャッシュを使わない) */
const ENVELOPE_CACHE_VERSION = 2

function envelopeCachePath(cacheDir: string, f: AudioFileRef, band: boolean): string {
  const key = createHash('sha1')
    .update(
      `${f.path}|${f.size}|${f.mtimeMs}|${contentFingerprint(f.path)}|${ENVELOPE_SAMPLE_RATE}|${ENVELOPE_RATE}|v${ENVELOPE_CACHE_VERSION}` +
        // 帯域を絞った包絡線(同期用)は別に持つ。絞らないもの(話者の判定・トラックの役割)の鍵は今までどおり
        (band ? `|band${SYNC_BAND_HZ.join('-')}` : '')
    )
    .digest('hex')
  return join(cacheDir, `${key}.env`)
}

function writeCachedEnvelope(cached: string, env: Float32Array): void {
  try {
    mkdirSync(dirname(cached), { recursive: true })
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

/**
 * 10ms ごとの音の大きさ(包絡線)。一度作ったものはキャッシュから読む。
 * `band`: 声の帯域に絞って測る(同期の相関用。`SYNC_BAND_HZ`)。読むときは絞ったもの・絞らないものを
 * 1回の読み込みで両方作ってキャッシュする(同期の後の話者の判定で、同じ素材をもう1回読まない)
 */
export async function cachedEnvelope(
  ffmpegPath: string,
  cacheDir: string,
  f: AudioFileRef,
  options: { band?: boolean } = {}
): Promise<Float32Array> {
  const band = options.band === true
  const cached = envelopeCachePath(cacheDir, f, band)
  if (existsSync(cached)) {
    const env = readCachedEnvelope(cached)
    if (env) return env
  }
  const plain = new EnvelopeBuilder(ENVELOPE_SAMPLE_RATE)
  const banded = new EnvelopeBuilder(ENVELOPE_SAMPLE_RATE, { band: true })
  await readPcm(
    ffmpegPath,
    [
      '-i',
      f.path,
      '-vn',
      '-af',
      PCM_ALIGN_FILTER,
      '-ac',
      '1',
      '-ar',
      String(ENVELOPE_SAMPLE_RATE),
      '-f',
      'f32le',
      'pipe:1'
    ],
    (s) => {
      plain.push(s)
      banded.push(s)
    }
  )
  const envs = { plain: plain.finish(), banded: banded.finish() }
  writeCachedEnvelope(envelopeCachePath(cacheDir, f, false), envs.plain)
  writeCachedEnvelope(envelopeCachePath(cacheDir, f, true), envs.banded)
  return band ? envs.banded : envs.plain
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
      '-af',
      PCM_ALIGN_FILTER,
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

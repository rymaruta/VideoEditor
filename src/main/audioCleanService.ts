import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { basename, extname, join } from 'path'
import rnnoiseModel from '../../resources/models/rnnoise_voice_lq.rnnn?asset'
import type { DenoiseResult } from '@shared/denoise'
import { escapeFilterPath, ffmpegPath, probeMedia } from './ffmpegService'

/**
 * ピンマイクのノイズ除去(計画書 §5.10)。RNNoise(ffmpeg の arnndn)で、笑い声も声として残すモデルを使う。
 *
 * ノイズを除いた音声を **1回だけ作ってキャッシュに置き**、素材がそれを指すようにする。
 * プレビューも書き出しも同じファイルを読むので、画面で聞いた音と書き出しの音が同じになる。
 *
 * arnndn は 480 サンプル(48kHz で 10ms)遅れて出てくる。そのぶん頭を詰め、末尾を無音で足して、
 * 元と同じ長さ・同じ時刻にする(口の動きとずれない。実測: 詰めたあとの遅れ 0 サンプル)。
 */
const MODEL_VERSION = 'rnnoise-lq-1'
const LATENCY_SAMPLES = 480

let running: ChildProcess | null = null
let canceled = false

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'clean-audio')
  mkdirSync(dir, { recursive: true })
  return dir
}

function cachePath(source: string): string {
  const st = statSync(source)
  const key = createHash('sha1')
    .update(`${MODEL_VERSION}\n${source}\n${st.size}\n${st.mtimeMs}`)
    .digest('hex')
    .slice(0, 12)
  return join(cacheDir(), `${basename(source, extname(source))}-${key}.flac`)
}

export function denoiseFilter(modelPath: string): string {
  return (
    `arnndn=m='${escapeFilterPath(modelPath)}',` +
    `atrim=start_sample=${LATENCY_SAMPLES},asetpts=N/SR/TB,apad=pad_len=${LATENCY_SAMPLES}`
  )
}

async function runOne(source: string, out: string, onPercent: (p: number) => void): Promise<void> {
  const duration = (await probeMedia(source).catch(() => null))?.duration ?? 0
  const tmp = `${out}.part.flac`
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-i',
        source,
        '-vn',
        '-af',
        denoiseFilter(rnnoiseModel.replace('app.asar', 'app.asar.unpacked')),
        '-c:a',
        'flac',
        tmp
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )
    running = child
    let tail = ''
    child.stderr!.on('data', (c: Buffer) => {
      const text = c.toString()
      tail = (tail + text).slice(-2000)
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(text)
      if (m && duration > 0)
        onPercent(
          Math.min(100, ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / duration) * 100)
        )
    })
    child.on('error', reject)
    child.on('close', (code) => {
      running = null
      if (code === 0) {
        renameSync(tmp, out)
        resolve()
        return
      }
      try {
        unlinkSync(tmp)
      } catch {
        // 途中のファイルが無ければそれでよい
      }
      reject(
        new Error(
          canceled
            ? 'DENOISE_CANCELED'
            : `ノイズ除去に失敗しました(${code}): ${tail.trim().split('\n').pop()}`
        )
      )
    })
  })
}

/** まとめて処理する(キャッシュにあれば作り直さない) */
export async function denoiseFiles(
  sources: string[],
  onProgress: (done: number, total: number, percent: number) => void
): Promise<DenoiseResult[]> {
  canceled = false
  const results: DenoiseResult[] = []
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    try {
      const out = cachePath(source)
      if (!existsSync(out))
        await runOne(source, out, (p) =>
          onProgress(i, sources.length, ((i + p / 100) / sources.length) * 100)
        )
      results.push({ source, cleaned: out })
    } catch (e) {
      if (canceled) throw e
      results.push({ source, error: e instanceof Error ? e.message : String(e) })
    }
    onProgress(i + 1, sources.length, ((i + 1) / sources.length) * 100)
  }
  return results
}

export function cancelDenoise(): void {
  canceled = true
  running?.kill()
}

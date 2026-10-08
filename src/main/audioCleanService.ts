import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { basename, extname, join } from 'path'
import rnnoiseModel from '../../resources/models/rnnoise_voice_lq.rnnn?asset'
import type { DenoiseResult } from '@shared/denoise'
import { escapeFilterPath, ffmpegPath, probeMedia } from './ffmpegService'
import { trackProcess } from './liveProcesses'
import { contentFingerprint } from './fileFingerprint'

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

/** 動いている ffmpeg(中止で全部止める) */
const running = new Set<ChildProcess>()
/**
 * 中止した回数。実行ごとに始めたときの値を覚え、違っていれば中止されている。
 * 1つの「中止した」印を実行ごとに戻していたので、中止の直後に始めた実行が、中止した実行の印まで消していた
 * (中止した実行が止まらず、残りの素材を処理し続けた)
 */
let cancelGeneration = 0
/** 中止で止めた ffmpeg(終わったときに「中止」として返す) */
const canceledChildren = new WeakSet<ChildProcess>()
/** 作っている途中の出力。同じ素材を同時に頼まれたら(自動編集と右クリックの「ノイズ除去」など)1回にまとめる */
const inFlight = new Map<string, Promise<void>>()

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'clean-audio')
  mkdirSync(dir, { recursive: true })
  return dir
}

function cachePath(source: string): string {
  const st = statSync(source)
  const key = createHash('sha1')
    .update(`${MODEL_VERSION}\n${source}\n${st.size}\n${st.mtimeMs}\n${contentFingerprint(source)}`)
    .digest('hex')
    .slice(0, 12)
  return join(cacheDir(), `${basename(source, extname(source))}-${key}.flac`)
}

export function denoiseFilter(modelPath: string): string {
  return (
    `arnndn=m=${escapeFilterPath(modelPath)},` +
    `atrim=start_sample=${LATENCY_SAMPLES},asetpts=N/SR/TB,apad=pad_len=${LATENCY_SAMPLES}`
  )
}

function runOne(source: string, out: string, onPercent: (p: number) => void): Promise<void> {
  const shared = inFlight.get(out)
  if (shared) return shared
  const task = runOneUnshared(source, out, onPercent, cancelGeneration).finally(() =>
    inFlight.delete(out)
  )
  inFlight.set(out, task)
  return task
}

async function runOneUnshared(
  source: string,
  out: string,
  onPercent: (p: number) => void,
  generation: number
): Promise<void> {
  const duration = (await probeMedia(source).catch(() => null))?.duration ?? 0
  // 中止が素材の合間に来ても、次の素材を始めない
  if (generation !== cancelGeneration) throw new Error('DENOISE_CANCELED')
  // 途中のファイルは実行ごとに別の名前(同じ名前だと、別の実行の書きかけを読み替えてしまう)
  const tmp = `${out}.${process.pid}-${Date.now()}.part.flac`
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
    running.add(child)
    const untrack = trackProcess(child)
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
      running.delete(child)
      untrack()
      if (code === 0) {
        // 名前の付け替えが失敗しても(Windows でウイルス対策が掴んでいる等)、main ごと落とさず失敗として返す
        try {
          renameSync(tmp, out)
          resolve()
        } catch (e) {
          try {
            unlinkSync(tmp)
          } catch {
            // 消せなければそのまま
          }
          reject(e)
        }
        return
      }
      try {
        unlinkSync(tmp)
      } catch {
        // 途中のファイルが無ければそれでよい
      }
      reject(
        new Error(
          canceledChildren.has(child)
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
  const generation = cancelGeneration
  const canceled = (): boolean => generation !== cancelGeneration
  const results: DenoiseResult[] = []
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    if (canceled()) throw new Error('DENOISE_CANCELED')
    try {
      const out = cachePath(source)
      if (!existsSync(out))
        await runOne(source, out, (p) =>
          onProgress(i, sources.length, ((i + p / 100) / sources.length) * 100)
        )
      results.push({ source, cleaned: out })
    } catch (e) {
      if (canceled()) throw new Error('DENOISE_CANCELED')
      results.push({ source, error: e instanceof Error ? e.message : String(e) })
    }
    onProgress(i + 1, sources.length, ((i + 1) / sources.length) * 100)
  }
  return results
}

export function cancelDenoise(): void {
  cancelGeneration++
  for (const child of running) {
    canceledChildren.add(child)
    child.kill()
  }
}

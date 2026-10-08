import { trackUntilDone } from './liveProcesses'
import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegStatic from 'ffmpeg-static'
import type { TranscriptSegment, TranscriptWord } from '@shared/types'
import { retryableSingleton } from './retryableSingleton'
import { describeFfmpegExit } from './ffmpegError'
import { ffSeconds } from './ffArgs'
import { PCM_ALIGN_FILTER } from './audioPcm'
import { fitSegmentsToRange } from '@shared/transcript'

const execFileAsyncRaw = promisify(execFile)
/** 外部の処理を始め、アプリを閉じるときに止める一覧に入れる */
const execFileAsync = (
  file: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> => {
  const p = execFileAsyncRaw(file, args)
  trackUntilDone(p.child)
  return p
}

const ffmpegPath = (ffmpegStatic as unknown as string).replace('app.asar', 'app.asar.unpacked')

const MODEL_ID = 'Xenova/whisper-base'

interface AsrChunk {
  text: string
  timestamp: [number, number | null]
}

interface AsrResult {
  text: string
  chunks?: AsrChunk[]
}

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<AsrResult>

/**
 * ダウンロードした音声認識モデルの置き場。
 *
 * transformers.js の既定は**モジュールからの相対**
 * (`node_modules/@huggingface/transformers/.cache/`)。開発中は書けるが、**配布版では
 * それが `app.asar` の中**——アーカイブ1ファイルなので、そこへ作ろうとすると
 * `ENOTDIR` で失敗する(実測: `mkdir .../app.asar/node_modules/@huggingface/transformers/.cache`
 * → `Not a directory`)。つまり**インストールして使う人だけ、初回の自動テロップで必ず落ちる**。
 * アプリが書いていい場所(userData)へ移す。BGM・ナレーションの保存先と同じ考え方。
 *
 * ここに置くと、アプリを入れ直してもモデルは残る(消したいときは userData ごと消せる)。
 */
function modelCacheDir(): string {
  const dir = join(app.getPath('userData'), 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

// 失敗を覚えないキャッシュ。接続を直して押し直せばやり直せる(進行中は1本に束ねる)
const getTranscriber = retryableSingleton<Transcriber>(async () => {
  const { env, pipeline } = await import('@huggingface/transformers')
  // 読み込みの前に置き場を差し替える(pipeline はここを見てダウンロード先を決める)
  env.cacheDir = modelCacheDir()
  return (await pipeline('automatic-speech-recognition', MODEL_ID, {
    dtype: 'fp32'
  })) as unknown as Transcriber
})

// Async on purpose: a synchronous ffmpeg call here blocks the whole main process
// (every IPC, dialog, even the close button) for the duration of the decode —
// seconds to minutes on long clips.
async function extractPcm16k(filePath: string, start: number, end: number): Promise<Float32Array> {
  const dir = mkdtempSync(join(tmpdir(), 've-whisper-'))
  const rawPath = join(dir, 'audio.f32le')
  try {
    try {
      await execFileAsync(ffmpegPath, [
        '-y',
        '-ss',
        ffSeconds(start),
        '-t',
        ffSeconds(end - start),
        '-i',
        filePath,
        // 音声の頭を素材の時刻にそろえる(同期・書き出しと同じ時刻で文字起こしする)
        '-af',
        PCM_ALIGN_FILTER,
        '-ar',
        '16000',
        '-ac',
        '1',
        '-f',
        'f32le',
        rawPath
      ])
    } catch (e) {
      // `execFile` の失敗はそのままだと **`Command failed: ` + コマンドライン全文 +
      // ffmpeg の版数とビルド設定の羅列**で、実測 **1,724文字・16行**が画面に出ていた。
      // 同じ原因(ファイルが無い)でも `probeMedia` は 31文字の日本語で出る。
      // ffmpeg を直に動かす経路は必ずここを通すこと(理由は `ffmpegError`)。
      const failure = e as { code?: number | null; stderr?: unknown }
      throw describeFfmpegExit(failure?.code, failure?.stderr)
    }
    const buf = readFileSync(rawPath)
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function transcribeRange(
  filePath: string,
  rangeStart: number,
  rangeEnd: number,
  language: string = 'japanese'
): Promise<TranscriptSegment[]> {
  const audio = await extractPcm16k(filePath, rangeStart, rangeEnd)
  // 音の無い区間(音声が映像より短い素材の終わりの先)は、認識に渡すと作り話を返すので渡さない
  if (audio.length === 0) return []
  let transcriber: Transcriber
  try {
    transcriber = await getTranscriber()
  } catch (e) {
    throw new Error(
      `音声認識モデルの読み込みに失敗しました(初回はインターネット接続が必要です): ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  }

  const result = await transcriber(audio, {
    language,
    task: 'transcribe',
    return_timestamps: true,
    chunk_length_s: 30
  })

  if (!result.chunks || result.chunks.length === 0) {
    const text = result.text?.trim()
    if (!text) return []
    return fitSegmentsToRange(
      [{ start: rangeStart, end: rangeEnd, text }],
      rangeStart,
      rangeEnd,
      quietIn(audio, rangeStart)
    )
  }

  return fitSegmentsToRange(
    result.chunks
      .map((chunk) => ({
        start: rangeStart + chunk.timestamp[0],
        end: rangeStart + (chunk.timestamp[1] ?? rangeEnd - rangeStart),
        text: chunk.text.trim()
      }))
      .filter((seg) => seg.text.length > 0),
    rangeStart,
    rangeEnd,
    quietIn(audio, rangeStart)
  )
}

/** 声があるかを見る細かさ(16kHz で 20ms) */
const FRAME = 320
/** 1つの区切りで見る長さの上限(秒)。終わりが分からない・長い区切りで、無音に薄められないように */
const QUIET_WINDOW_SEC = 2
/** 静かな所を見積もる範囲(前後の秒)。区間の頭に無音があると、全体で見積もって 0 になっていた */
const FLOOR_SPAN_SEC = 5

/**
 * 読んだ音(16kHz)で、素材の時刻 [start, end) に声が無いかを返す関数。決まり文句の作り話を、
 * 声の無い所に出たものだけ捨てるのに使う。
 *
 * 1つの大きさ(全体の RMS)で決めると、ふつうの部屋の雑音の上の作り話を残し、終わりの分からない
 * 区切りで本当に言った締めの言葉を無音に薄めて捨てていた。20ms ごとの大きさを、その音の静かな所
 * (前後 5 秒の下から1割)より 12dB 以上大きい所を声として数え、見る長さ(頭から2秒まで)の4割以上が声なら声あり
 */
function quietIn(audio: Float32Array, rangeStart: number): (start: number, end: number) => boolean {
  const frames = Math.floor(audio.length / FRAME)
  const rms = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += audio[i] * audio[i]
    rms[f] = Math.sqrt(sum / FRAME)
  }
  const span = Math.round((FLOOR_SPAN_SEC * 16000) / FRAME)
  return (start, end) => {
    // 長さの無い区切り(言葉の時刻が1点)は、その頭の少しを見る
    const s = start - rangeStart
    const e = Math.min(end - rangeStart, s + QUIET_WINDOW_SEC)
    const from = Math.max(0, Math.floor((s * 16000) / FRAME))
    const to = Math.min(frames, Math.ceil((Math.max(e, s + 0.3) * 16000) / FRAME))
    if (to <= from) return true
    // 静かな所(下から1割)は、その区切りの前後 5 秒で見積もる。録音の無い所(デジタルの無音)は除き、
    // 半分以上が無音なら静かな所は 0(録音の頭・終わりの無音で 0 になり、部屋の雑音を声と取っていた)
    const win = rms.subarray(Math.max(0, from - span), Math.min(frames, to + span))
    const near = Float32Array.from(win.filter((v) => v > 1e-4)).sort()
    const floor = near.length >= win.length * 0.5 ? near[Math.floor(near.length * 0.1)] : 0
    // 声とみなす大きさ。静かな所の 4 倍(12dB)。ただし -34dBFS(0.02)を超えれば声とみなす(全体が同じ
    // 大きさで鳴り続ける音では、静かな所の見積もりがその大きさになり、声をすべて無音と取っていた)
    const voiced = Math.max(0.002, Math.min(floor * 4, 0.02))
    let loud = 0
    for (let f = from; f < to; f++) if (rms[f] > voiced) loud++
    return loud < (to - from) * 0.4
  }
}

function buildWordSegment(words: { raw: string; start: number; end: number }[]): TranscriptSegment {
  const wordList: TranscriptWord[] = words.map((w, i) => ({
    start: w.start,
    end: w.end,
    text: i === 0 ? w.raw.trimStart() : w.raw
  }))
  return {
    start: wordList[0].start,
    end: wordList[wordList.length - 1].end,
    text: wordList.map((w) => w.text).join(''),
    words: wordList
  }
}

export async function transcribeWordsRange(
  filePath: string,
  rangeStart: number,
  rangeEnd: number,
  language: string = 'japanese',
  maxWordsPerSegment = 5,
  maxGapSeconds = 0.6
): Promise<TranscriptSegment[]> {
  const audio = await extractPcm16k(filePath, rangeStart, rangeEnd)
  // 音の無い区間(音声が映像より短い素材の終わりの先)は、認識に渡すと作り話を返すので渡さない
  if (audio.length === 0) return []
  let transcriber: Transcriber
  try {
    transcriber = await getTranscriber()
  } catch (e) {
    throw new Error(
      `音声認識モデルの読み込みに失敗しました(初回はインターネット接続が必要です): ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  }

  const result = await transcriber(audio, {
    language,
    task: 'transcribe',
    return_timestamps: 'word',
    chunk_length_s: 30
  })

  const words = (result.chunks ?? [])
    .map((c) => ({
      raw: c.text,
      start: rangeStart + c.timestamp[0],
      end: rangeStart + (c.timestamp[1] ?? c.timestamp[0])
    }))
    .filter((w) => w.raw.trim().length > 0)

  if (words.length === 0) return []

  const segments: TranscriptSegment[] = []
  let current: typeof words = []
  for (const w of words) {
    if (current.length > 0) {
      const gap = w.start - current[current.length - 1].end
      if (current.length >= maxWordsPerSegment || gap > maxGapSeconds) {
        segments.push(buildWordSegment(current))
        current = []
      }
    }
    current.push(w)
  }
  if (current.length > 0) segments.push(buildWordSegment(current))
  return fitSegmentsToRange(segments, rangeStart, rangeEnd, quietIn(audio, rangeStart))
}

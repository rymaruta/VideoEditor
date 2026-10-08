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
    return [{ start: rangeStart, end: rangeEnd, text }]
  }

  return result.chunks
    .map((chunk) => ({
      start: rangeStart + chunk.timestamp[0],
      end: rangeStart + (chunk.timestamp[1] ?? rangeEnd - rangeStart),
      text: chunk.text.trim()
    }))
    .filter((seg) => seg.text.length > 0)
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
  return segments
}

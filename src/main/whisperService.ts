import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegStatic from 'ffmpeg-static'
import type { TranscriptSegment } from '@shared/types'

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

let transcriberPromise: Promise<Transcriber> | null = null

async function getTranscriber(): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers')
      return (await pipeline('automatic-speech-recognition', MODEL_ID, {
        dtype: 'fp32'
      })) as unknown as Transcriber
    })()
  }
  return transcriberPromise
}

function extractPcm16k(filePath: string, start: number, end: number): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 've-whisper-'))
  const rawPath = join(dir, 'audio.f32le')
  try {
    execFileSync(ffmpegPath, [
      '-y',
      '-ss',
      String(start),
      '-t',
      String(end - start),
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
  const audio = extractPcm16k(filePath, rangeStart, rangeEnd)
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

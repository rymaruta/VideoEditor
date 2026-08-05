import ffmpeg from 'fluent-ffmpeg'
import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Codecs Chromium's <video> can decode. Everything else has to be transcoded before
 * it can be previewed. This is an allow-list on purpose: an unknown codec failing to
 * play silently is much worse than transcoding something that would have played.
 *
 * H.265/HEVC is the notable absence — Chromium ships without a decoder for licensing
 * reasons, and it is what most game-capture tools (ShadowPlay, iPhone, capture cards)
 * record in.
 */
const PREVIEWABLE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora'])
const PREVIEWABLE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le'])

export function needsPreviewProxy(
  videoCodec: string,
  audioCodec: string,
  hasVideo: boolean,
  hasAudio: boolean
): boolean {
  if (hasVideo && !PREVIEWABLE_VIDEO_CODECS.has(videoCodec)) return true
  if (hasAudio && !PREVIEWABLE_AUDIO_CODECS.has(audioCodec)) return true
  return false
}

interface ProxyStreamInfo {
  audioCodec: string
  hasAudio: boolean
}

function probeStreams(filePath: string): Promise<ProxyStreamInfo> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data) return resolve({ audioCodec: '', hasAudio: false })
      const audio = data.streams.find((s) => s.codec_type === 'audio')
      resolve({ audioCodec: audio?.codec_name ?? '', hasAudio: Boolean(audio) })
    })
  })
}

function proxyDir(): string {
  const dir = join(app.getPath('userData'), 'preview-proxies')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Keyed by path + size + mtime rather than by asset id, so re-importing the same file
 * (or opening a saved project) reuses the existing proxy instead of transcoding again,
 * while a file that was edited in place still gets a fresh one.
 */
function proxyPathFor(filePath: string): string {
  let stamp = ''
  try {
    const st = statSync(filePath)
    stamp = `${st.size}:${st.mtimeMs}`
  } catch {
    stamp = ''
  }
  const key = createHash('sha1').update(`${filePath}|${stamp}`).digest('hex').slice(0, 16)
  return join(proxyDir(), `${key}.mp4`)
}

// Concurrent imports of the same file would otherwise race on the same output path and
// produce a truncated proxy; the second caller waits on the first one's promise instead.
const inFlight = new Map<string, Promise<string>>()

export function ensurePreviewProxy(
  filePath: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  const outPath = proxyPathFor(filePath)
  if (existsSync(outPath)) return Promise.resolve(outPath)
  const running = inFlight.get(outPath)
  if (running) return running

  // Written to a temporary name and renamed only on success, so an interrupted run
  // can never leave a half-written file that would later be treated as a valid cache.
  const tmpPath = `${outPath}.partial.mp4`
  const task = probeStreams(filePath)
    .then(
      ({ audioCodec, hasAudio }) =>
        new Promise<string>((resolve, reject) => {
          const command = ffmpeg(filePath).videoCodec('libx264').outputOptions([
            '-preset veryfast',
            '-crf 28',
            // 540p is plenty for a preview and roughly halves both the encode time and
            // the file size versus 720p. Export is unaffected — it reads the original.
            '-vf scale=-2:min(540\\,ih)',
            '-pix_fmt yuv420p',
            '-movflags +faststart'
          ])
          // Re-encoding audio that the preview can already play is wasted time; only the
          // video stream is actually the problem in the common HEVC case.
          if (!hasAudio) command.noAudio()
          else if (PREVIEWABLE_AUDIO_CODECS.has(audioCodec)) command.audioCodec('copy')
          else command.audioCodec('aac').outputOptions(['-ac 2'])
          command
            .on('progress', (p) => {
              if (onProgress && typeof p.percent === 'number') {
                onProgress(Math.max(0, Math.min(100, Math.round(p.percent))))
              }
            })
            .on('error', (err) => {
              rmSync(tmpPath, { force: true })
              reject(err)
            })
            .on('end', () => {
              try {
                renameSync(tmpPath, outPath)
                resolve(outPath)
              } catch (e) {
                rmSync(tmpPath, { force: true })
                reject(e)
              }
            })
            .save(tmpPath)
        })
    )
    .finally(() => {
      inFlight.delete(outPath)
    })

  inFlight.set(outPath, task)
  return task
}

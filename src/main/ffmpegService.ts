import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { readFileSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  AspectRatio,
  MediaProbeResult,
  Project,
  QualityPreset,
  ResolutionHeight,
  SilenceRange,
  TransitionType
} from '@shared/types'
import { buildAssContent } from './assSubtitle'

export const ffmpegPath = (ffmpegStatic as unknown as string).replace(
  'app.asar',
  'app.asar.unpacked'
)
const ffprobePath = ffprobeStatic.path.replace('app.asar', 'app.asar.unpacked')

ffmpeg.setFfmpegPath(ffmpegPath)
ffmpeg.setFfprobePath(ffprobePath)

export function probeMedia(filePath: string): Promise<MediaProbeResult> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err)
      const videoStream = data.streams.find((s) => s.codec_type === 'video')
      const audioStream = data.streams.find((s) => s.codec_type === 'audio')
      if (!videoStream && !audioStream) {
        return reject(new Error('動画・音声トラックが見つかりませんでした'))
      }
      let fps = 30
      if (videoStream?.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split('/').map(Number)
        if (den) fps = num / den
      }
      resolve({
        duration: Number(
          data.format.duration ?? videoStream?.duration ?? audioStream?.duration ?? 0
        ),
        width: videoStream?.width ?? 0,
        height: videoStream?.height ?? 0,
        fps,
        hasAudio: Boolean(audioStream),
        hasVideo: Boolean(videoStream)
      })
    })
  })
}

export function generateThumbnailDataUrl(filePath: string, atSeconds: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 've-thumb-'))
  const outFile = join(dir, 'thumb.jpg')
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .on('error', reject)
      .on('end', () => {
        try {
          const buf = readFileSync(outFile)
          resolve(`data:image/jpeg;base64,${buf.toString('base64')}`)
        } catch (e) {
          reject(e)
        }
      })
      .screenshots({
        timestamps: [atSeconds],
        filename: 'thumb.jpg',
        folder: dir,
        size: '320x?'
      })
  })
}

export function generateFrameDataUrl(
  filePath: string,
  atSeconds: number,
  width: number,
  height: number
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 've-frame-'))
  const outFile = join(dir, 'frame.jpg')
  const w = Math.round(width)
  const h = Math.round(height)
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .inputOptions([`-ss ${atSeconds}`])
      .complexFilter([
        `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v]`
      ])
      .outputOptions(['-map [v]', '-frames:v 1'])
      .output(outFile)
      .on('error', reject)
      .on('end', () => {
        try {
          const buf = readFileSync(outFile)
          resolve(`data:image/jpeg;base64,${buf.toString('base64')}`)
        } catch (e) {
          reject(e)
        }
      })
      .run()
  })
}

export function generateWaveformDataUrl(
  filePath: string,
  start: number,
  end: number,
  width: number,
  height: number
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 've-wave-'))
  const outFile = join(dir, 'wave.png')
  const safeWidth = Math.max(20, Math.round(width))
  const safeHeight = Math.max(10, Math.round(height))
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .inputOptions([`-ss ${start}`, `-t ${Math.max(0.05, end - start)}`])
      .complexFilter([
        `[0:a]aformat=channel_layouts=mono,showwavespic=s=${safeWidth}x${safeHeight}:colors=0x9c8cf6[v]`
      ])
      .outputOptions(['-map [v]', '-frames:v 1'])
      .output(outFile)
      .on('error', reject)
      .on('end', () => {
        try {
          const buf = readFileSync(outFile)
          resolve(`data:image/png;base64,${buf.toString('base64')}`)
        } catch (e) {
          reject(e)
        }
      })
      .run()
  })
}

const SILENCE_NOISE_DB = -30
const SILENCE_MIN_DURATION = 0.5

export function detectSilence(
  filePath: string,
  rangeStart: number,
  rangeEnd: number
): Promise<SilenceRange[]> {
  return new Promise((resolve, reject) => {
    const ranges: SilenceRange[] = []
    let pendingStart: number | null = null
    const duration = rangeEnd - rangeStart

    ffmpeg(filePath)
      .inputOptions([`-ss ${rangeStart}`, `-t ${duration}`])
      .outputOptions([
        `-af silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_DURATION}`,
        '-f null'
      ])
      .output('-')
      .on('stderr', (line: string) => {
        const startMatch = /silence_start:\s*(-?[\d.]+)/.exec(line)
        if (startMatch) {
          pendingStart = Number(startMatch[1])
          return
        }
        const endMatch = /silence_end:\s*(-?[\d.]+)/.exec(line)
        if (endMatch && pendingStart !== null) {
          ranges.push({
            start: rangeStart + Math.max(0, pendingStart),
            end: rangeStart + Number(endMatch[1])
          })
          pendingStart = null
        }
      })
      .on('error', (err) => reject(err))
      .on('end', () => {
        if (pendingStart !== null) {
          ranges.push({ start: rangeStart + pendingStart, end: rangeEnd })
        }
        resolve(ranges)
      })
      .run()
  })
}

function targetResolution(
  aspectRatio: AspectRatio,
  standard: ResolutionHeight
): { w: number; h: number } {
  const longSide = Math.round((standard * 16) / 9 / 2) * 2
  if (aspectRatio === '9:16') {
    return { w: standard, h: longSide }
  }
  return { w: longSide, h: standard }
}

function crfForQuality(quality: QualityPreset): number {
  switch (quality) {
    case 'high':
      return 18
    case 'small':
      return 28
    default:
      return 22
  }
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")
}

function xfadeName(type: TransitionType): string {
  switch (type) {
    case 'fade':
      return 'fadeblack'
    case 'wipe':
      return 'wipeleft'
    default:
      return 'fade'
  }
}

export interface ExportOptions {
  project: Project
  aspectRatio: AspectRatio
  resolutionHeight: ResolutionHeight
  quality: QualityPreset
  outputPath: string
  loudnessNormalization?: boolean
  onProgress: (percent: number, stage: string) => void
}

export function exportProject(options: ExportOptions): Promise<void> {
  const { project, aspectRatio, resolutionHeight, quality, outputPath, onProgress } = options
  const loudnessNormalization = options.loudnessNormalization ?? false
  const { w, h } = targetResolution(aspectRatio, resolutionHeight)
  const assetById = new Map(project.assets.map((a) => [a.id, a]))
  const clips = project.clips
  if (clips.length === 0) {
    return Promise.reject(new Error('タイムラインにクリップがありません'))
  }

  const clipOutputDurations = clips.map((c) => (c.outPoint - c.inPoint) / (c.speed || 1))
  const totalDuration = clipOutputDurations.reduce((sum, d) => sum + d, 0)

  return new Promise((resolve, reject) => {
    let command: ffmpeg.FfmpegCommand
    try {
      command = ffmpeg()
      const filterParts: string[] = []
      let inputIndex = 0

      // --- Main video track: per-clip decode + scale/pad + speed ---
      clips.forEach((clip, i) => {
        const asset = assetById.get(clip.assetId)
        if (!asset) throw new Error(`アセットが見つかりません: ${clip.assetId}`)
        const speed = clip.speed || 1
        const sourceDuration = clip.outPoint - clip.inPoint
        const outputDuration = clipOutputDurations[i]
        command.input(asset.filePath).inputOptions([`-ss ${clip.inPoint}`, `-t ${sourceDuration}`])
        const myIndex = inputIndex++

        filterParts.push(
          `[${myIndex}:v]setpts=PTS/${speed},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[v${i}]`
        )
        if (asset.hasAudio) {
          filterParts.push(
            `[${myIndex}:a]atempo=${Math.min(2, Math.max(0.5, speed))},aresample=async=1,asetpts=PTS-STARTPTS[a${i}]`
          )
        } else {
          filterParts.push(
            `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${outputDuration}[a${i}]`
          )
        }
      })

      // --- Fold clips together sequentially, applying transitions where set ---
      let curV = 'v0'
      let curA = 'a0'
      let curDuration = clipOutputDurations[0]
      for (let i = 1; i < clips.length; i++) {
        const clip = clips[i]
        const incomingDuration = clipOutputDurations[i]
        const transition = clip.transitionIn
        if (!transition || transition.type === 'none' || transition.duration <= 0) {
          const outV = `vcat${i}`
          const outA = `acat${i}`
          filterParts.push(`[${curV}][v${i}]concat=n=2:v=1:a=0[${outV}]`)
          filterParts.push(`[${curA}][a${i}]concat=n=2:v=0:a=1[${outA}]`)
          curV = outV
          curA = outA
          curDuration = curDuration + incomingDuration
        } else {
          const maxDur = Math.max(0.1, Math.min(curDuration, incomingDuration) - 0.05)
          const t = Math.min(transition.duration, maxDur)
          const offset = Math.max(0, curDuration - t)
          const outV = `vxf${i}`
          const outA = `axf${i}`
          filterParts.push(
            `[${curV}][v${i}]xfade=transition=${xfadeName(transition.type)}:duration=${t}:offset=${offset}[${outV}]`
          )
          filterParts.push(`[${curA}][a${i}]acrossfade=d=${t}[${outA}]`)
          curV = outV
          curA = outA
          curDuration = curDuration + incomingDuration - t
        }
      }

      let videoLabel = `[${curV}]`
      if (project.textOverlays.length > 0) {
        const assDir = mkdtempSync(join(tmpdir(), 've-subs-'))
        const assPath = join(assDir, 'overlay.ass')
        writeFileSync(assPath, buildAssContent(project.textOverlays, w, h), 'utf-8')
        filterParts.push(`[${curV}]subtitles=filename='${escapeFilterPath(assPath)}'[vout]`)
        videoLabel = '[vout]'
      }

      // --- Extra audio tracks (BGM / narration) mixed on top of the main audio ---
      const extraAudioLabels: string[] = []
      project.audioTracks.forEach((track, trackIdx) => {
        if (track.muted) return
        track.clips.forEach((trackClip, clipIdx) => {
          const asset = assetById.get(trackClip.assetId)
          if (!asset) return
          const dur = trackClip.outPoint - trackClip.inPoint
          command.input(asset.filePath).inputOptions([`-ss ${trackClip.inPoint}`, `-t ${dur}`])
          const myIndex = inputIndex++
          const label = `atrk${trackIdx}_${clipIdx}`
          const delayMs = Math.max(0, Math.round(trackClip.startTime * 1000))
          filterParts.push(
            `[${myIndex}:a]asetpts=PTS-STARTPTS,volume=${track.volume},adelay=${delayMs}|${delayMs}[${label}]`
          )
          extraAudioLabels.push(label)
        })
      })

      let audioLabel = `[${curA}]`
      if (extraAudioLabels.length > 0) {
        const mixInputs = [`[${curA}]`, ...extraAudioLabels.map((l) => `[${l}]`)].join('')
        filterParts.push(
          `${mixInputs}amix=inputs=${extraAudioLabels.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`
        )
        audioLabel = '[aout]'
      }

      if (loudnessNormalization) {
        filterParts.push(`${audioLabel}loudnorm=I=-14:TP=-1.5:LRA=11[aloud]`)
        audioLabel = '[aloud]'
      }

      command
        .complexFilter(filterParts)
        .outputOptions([
          `-map ${videoLabel}`,
          `-map ${audioLabel}`,
          '-c:v libx264',
          '-preset veryfast',
          `-crf ${crfForQuality(quality)}`,
          '-c:a aac',
          '-b:a 192k',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('start', () => onProgress(0, 'エンコード開始'))
        .on('progress', (progress) => {
          const seconds = timemarkToSeconds(progress.timemark)
          const percent = totalDuration > 0 ? Math.min(99, (seconds / totalDuration) * 100) : 0
          onProgress(percent, 'エンコード中')
        })
        .on('error', (err) => reject(err))
        .on('end', () => {
          onProgress(100, '完了')
          resolve()
        })
        .run()
    } catch (e) {
      reject(e)
    }
  })
}

function timemarkToSeconds(timemark: string): number {
  const parts = timemark.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return Number(timemark) || 0
}

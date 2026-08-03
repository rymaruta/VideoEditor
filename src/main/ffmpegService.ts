import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { readFileSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AspectRatio, MediaProbeResult, Project } from '@shared/types'
import { buildAssContent } from './assSubtitle'

const ffmpegPath = (ffmpegStatic as unknown as string).replace('app.asar', 'app.asar.unpacked')
const ffprobePath = ffprobeStatic.path.replace('app.asar', 'app.asar.unpacked')

ffmpeg.setFfmpegPath(ffmpegPath)
ffmpeg.setFfprobePath(ffprobePath)

export function probeMedia(filePath: string): Promise<MediaProbeResult> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err)
      const videoStream = data.streams.find((s) => s.codec_type === 'video')
      const audioStream = data.streams.find((s) => s.codec_type === 'audio')
      if (!videoStream) return reject(new Error('動画トラックが見つかりませんでした'))
      let fps = 30
      if (videoStream.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split('/').map(Number)
        if (den) fps = num / den
      }
      resolve({
        duration: Number(data.format.duration ?? videoStream.duration ?? 0),
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
        fps,
        hasAudio: Boolean(audioStream)
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

function targetResolution(aspectRatio: AspectRatio, height: 720 | 1080): { w: number; h: number } {
  if (aspectRatio === '9:16') {
    return { w: height === 1080 ? 1080 : 720, h: height === 1080 ? 1920 : 1280 }
  }
  return { w: height === 1080 ? 1920 : 1280, h: height }
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")
}

export interface ExportOptions {
  project: Project
  aspectRatio: AspectRatio
  resolutionHeight: 720 | 1080
  outputPath: string
  onProgress: (percent: number, stage: string) => void
}

export function exportProject(options: ExportOptions): Promise<void> {
  const { project, aspectRatio, resolutionHeight, outputPath, onProgress } = options
  const { w, h } = targetResolution(aspectRatio, resolutionHeight)
  const assetById = new Map(project.assets.map((a) => [a.id, a]))
  const clips = project.clips
  if (clips.length === 0) {
    return Promise.reject(new Error('タイムラインにクリップがありません'))
  }

  const totalDuration = clips.reduce((sum, c) => sum + (c.outPoint - c.inPoint), 0)

  return new Promise((resolve, reject) => {
    let command: ffmpeg.FfmpegCommand
    try {
      command = ffmpeg()
      const filterParts: string[] = []

      clips.forEach((clip, i) => {
        const asset = assetById.get(clip.assetId)
        if (!asset) throw new Error(`アセットが見つかりません: ${clip.assetId}`)
        const clipDuration = clip.outPoint - clip.inPoint
        command.input(asset.filePath).inputOptions([`-ss ${clip.inPoint}`, `-t ${clipDuration}`])

        filterParts.push(
          `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[v${i}]`
        )
        if (asset.hasAudio) {
          filterParts.push(`[${i}:a]aresample=async=1,asetpts=PTS-STARTPTS[a${i}]`)
        } else {
          filterParts.push(
            `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${clipDuration}[a${i}]`
          )
        }
      })

      const concatInputs = clips.map((_, i) => `[v${i}][a${i}]`).join('')
      filterParts.push(`${concatInputs}concat=n=${clips.length}:v=1:a=1[vcat][acat]`)

      let videoLabel = '[vcat]'
      if (project.textOverlays.length > 0) {
        const assDir = mkdtempSync(join(tmpdir(), 've-subs-'))
        const assPath = join(assDir, 'overlay.ass')
        writeFileSync(assPath, buildAssContent(project.textOverlays, w, h), 'utf-8')
        filterParts.push(`[vcat]subtitles=filename='${escapeFilterPath(assPath)}'[vout]`)
        videoLabel = '[vout]'
      }

      command
        .complexFilter(filterParts)
        .outputOptions([
          `-map ${videoLabel}`,
          '-map [acat]',
          '-c:v libx264',
          '-preset veryfast',
          '-crf 20',
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

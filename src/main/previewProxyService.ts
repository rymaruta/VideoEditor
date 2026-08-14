import ffmpeg from 'fluent-ffmpeg'
import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { describeFfmpegError } from './ffmpegError'
import {
  isMonoChannelCount,
  isMultiChannelCount,
  monoUpmixFilter,
  multiChannelDownmixFilter
} from '@shared/audioUpmix'

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
  /** 0 は「分からなかった」。等倍のモノラル展開を掛けてよいのは 1 のときだけ。 */
  audioChannels: number
}

function probeStreams(filePath: string): Promise<ProxyStreamInfo> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data) return resolve({ audioCodec: '', hasAudio: false, audioChannels: 0 })
      const audio = data.streams.find((s) => s.codec_type === 'audio')
      resolve({
        audioCodec: audio?.codec_name ?? '',
        hasAudio: Boolean(audio),
        audioChannels: audio?.channels ?? 0
      })
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
//
// **進捗の宛先は1人ではなく全員。** 同じファイルを2回読み込むと素材は2件になり、
// メディア一覧の行も2つ出る。変換は1回で済ませるのが正しいが、進捗を**最初の1人に
// しか流さない**と、2つ目の行は**変換が終わるまで 0% のまま固まって見える**
// (実測: 60秒のHEVCで 1人目は10回進捗を受け取り、2人目・3人目は**0回**)。
// 待っている人が増えたら、その人の受け口も足す。
interface ProxyJob {
  promise: Promise<string>
  listeners: Set<(percent: number) => void>
}
const inFlight = new Map<string, ProxyJob>()

export function ensurePreviewProxy(
  filePath: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  const outPath = proxyPathFor(filePath)
  if (existsSync(outPath)) return Promise.resolve(outPath)
  const running = inFlight.get(outPath)
  if (running) {
    if (onProgress) running.listeners.add(onProgress)
    return running.promise
  }
  const listeners = new Set<(percent: number) => void>()
  if (onProgress) listeners.add(onProgress)
  // 1人の受け口が投げても、他の人への通知と変換そのものを巻き込まない。
  const notifyProgress = (percent: number): void => {
    for (const listener of listeners) {
      try {
        listener(percent)
      } catch {
        // 進捗を受け取れない相手が居ても、変換は続ける。
      }
    }
  }

  // Written to a temporary name and renamed only on success, so an interrupted run
  // can never leave a half-written file that would later be treated as a valid cache.
  const tmpPath = `${outPath}.partial.mp4`
  const task = probeStreams(filePath)
    .then(
      ({ audioCodec, hasAudio, audioChannels }) =>
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
          else {
            command.audioCodec('aac').outputOptions(['-ac 2'])
            // `-ac 2` の裏の swresample は**モノラルを左右へ 1/√2 で配る**ので、
            // 変換した素材だけ試聴が 3dB 小さくなる。同じモノラルでも H.264 の素材は
            // そのまま再生されて等倍なので、**素材の符号化方式で音量が変わる**——
            // しかも書き出しは等倍で出る(理由は `@shared/audioUpmix`)。
            // 実測: mono の 200Hz を `-ac 2` だけで変換すると max -24.1 → -26.6 dB、
            // この一段を足すと -23.7 dB(AAC の誤差ぶんを含めて等倍)。
            if (isMonoChannelCount(audioChannels)) {
              command.audioFilters(monoUpmixFilter())
            } else if (isMultiChannelCount(audioChannels)) {
              // 3ch 以上を畳むときは、`-ac 2` の裏の swresample が**浮動小数の出力では
              // 行列の正規化を外す**ので、試聴だけが持ち上がって割れる。書き出しと
              // 同じく明示して戻す(理由は `@shared/audioUpmix`)。
              // 実測(無相関な5.1): `-ac 2` だけだと mean -10.9 dB・ピーク 0.0 dB で
              // **430サンプルが 0dBFS に張り付く**。この一段を足すと -18.6 dB・-5.6 dB。
              // ここを通るのは AC-3 / DTS のように**そのまま再生できない音声**で、
              // それはまさに 5.1 を運んでいる形式でもある。
              command.audioFilters(multiChannelDownmixFilter())
            }
          }
          command
            .on('progress', (p) => {
              if (typeof p.percent === 'number') {
                notifyProgress(Math.max(0, Math.min(100, Math.round(p.percent))))
              }
            })
            .on('error', (err) => {
              rmSync(tmpPath, { force: true })
              reject(describeFfmpegError(err))
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
      listeners.clear()
    })

  inFlight.set(outPath, { promise: task, listeners })
  return task
}

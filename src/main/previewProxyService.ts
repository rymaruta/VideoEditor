import ffmpeg from 'fluent-ffmpeg'
import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { describeFfmpegError } from './ffmpegError'
import { isShuttingDown, trackProcess } from './liveProcesses'
import { detectVideoEncoder } from './segmentRenderer'
import { contentFingerprint } from './fileFingerprint'
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
  /** 映像が透過(アルファ)を持つ(版面CG の ProRes 4444・QuickTime Animation など) */
  hasAlpha: boolean
  /** 0 は「分からなかった」。等倍のモノラル展開を掛けてよいのは 1 のときだけ。 */
  audioChannels: number
}

function probeStreams(filePath: string): Promise<ProxyStreamInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      // 調べられなかったのに「音なし」で作ると、無音の試聴用素材がずっと使われ続ける
      if (err || !data)
        return reject(
          new Error(`素材を調べられませんでした: ${err instanceof Error ? err.message : filePath}`)
        )
      const audio = data.streams.find((s) => s.codec_type === 'audio')
      const video = data.streams.find((s) => s.codec_type === 'video')
      resolve({
        hasAlpha: hasAlphaPixelFormat(String(video?.pix_fmt ?? '')),
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
function proxyPathFor(filePath: string, ext: 'mp4' | 'webm' = 'mp4'): string {
  let stamp = ''
  try {
    const st = statSync(filePath)
    // 同じ大きさ・同じ更新時刻のファイルへ差し替えても前の変換を使わないよう、中身の目印も足す
    stamp = `${st.size}:${st.mtimeMs}:${contentFingerprint(filePath)}`
  } catch {
    stamp = ''
  }
  const key = createHash('sha1').update(`${filePath}|${stamp}`).digest('hex').slice(0, 16)
  return join(proxyDir(), `${key}.${ext}`)
}

/** 透過(アルファ)を持つ画素の形式か(yuva420p・rgba・argb・gbrap・ya8 など) */
export function hasAlphaPixelFormat(pixFmt: string): boolean {
  return /^(yuva|gbra|ya\d)|^(rgba|bgra|argb|abgr)|^rgba64|^bgra64/.test(pixFmt)
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
  // 透過を持つ素材(版面CG)は、透過を保てる VP9(WebM)で作る。H.264 にすると背景が黒く塗られる
  const alphaPath = proxyPathFor(filePath, 'webm')
  if (existsSync(alphaPath)) return Promise.resolve(alphaPath)
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
  const task = Promise.all([probeStreams(filePath), detectVideoEncoder()])
    .then(
      ([{ audioCodec, hasAudio, hasAlpha, audioChannels }, encoder]) =>
        new Promise<string>((resolve, reject) => {
          const finalPath = hasAlpha ? alphaPath : outPath
          const tmpPath = hasAlpha ? `${alphaPath}.partial.webm` : `${outPath}.partial.mp4`
          if (hasAlpha) {
            // VP9 のアルファ付き。WebM には AAC を入れられないので音は Opus にする
            const command = ffmpeg(filePath)
              .videoCodec('libvpx-vp9')
              .outputOptions([
                '-vf scale=-2:min(540\\,ih)',
                '-pix_fmt yuva420p',
                '-b:v 0',
                '-crf 34',
                '-deadline realtime',
                '-cpu-used 8',
                '-row-mt 1',
                '-auto-alt-ref 0'
              ])
            if (hasAudio) command.audioCodec('libopus').outputOptions(['-ac 2'])
            else command.noAudio()
            command
              .on('progress', (p) => {
                if (typeof p.percent === 'number')
                  notifyProgress(Math.max(0, Math.min(100, Math.round(p.percent))))
              })
              .on('error', (err, _stdout, stderr) => {
                untrack()
                rmSync(tmpPath, { force: true })
                reject(describeFfmpegError(err, stderr))
              })
              .on('end', () => {
                untrack()
                try {
                  renameSync(tmpPath, finalPath)
                  resolve(finalPath)
                } catch (e) {
                  rmSync(tmpPath, { force: true })
                  reject(e)
                }
              })
            const untrack = trackProcess(command)
            command.save(tmpPath)
            return
          }
          const encode = (gpu: boolean): void => {
            const command = ffmpeg(filePath)
            if (gpu) {
              // GPU(NVIDIA)で読んで GPU で書く。4K・HEVC の多カメラの素材は CPU だと
              // 何時間もかかる。読み(NVDEC)は使えない形式なら ffmpeg が自動で CPU に戻す
              command
                .inputOptions(['-hwaccel cuda'])
                .videoCodec('h264_nvenc')
                .outputOptions(['-preset p4', '-rc vbr', '-cq 30', '-b:v 0'])
            } else command.videoCodec('libx264').outputOptions(['-preset veryfast', '-crf 28'])
            command.outputOptions([
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
                command.audioFilters(multiChannelDownmixFilter(undefined, audioChannels))
              }
            }
            command
              .on('progress', (p) => {
                if (typeof p.percent === 'number') {
                  notifyProgress(Math.max(0, Math.min(100, Math.round(p.percent))))
                }
              })
              .on('error', (err, _stdout, stderr) => {
                untrack()
                rmSync(tmpPath, { force: true })
                // GPU で失敗したら(同時に開ける数の上限・ドライバ)、CPU で作り直す。
                // アプリを閉じるために止めたのなら作り直さない
                if (gpu && !isShuttingDown()) {
                  notifyProgress(0)
                  encode(false)
                } else reject(describeFfmpegError(err, stderr))
              })
              .on('end', () => {
                untrack()
                try {
                  renameSync(tmpPath, outPath)
                  resolve(outPath)
                } catch (e) {
                  rmSync(tmpPath, { force: true })
                  reject(e)
                }
              })
            const untrack = trackProcess(command)
            command.save(tmpPath)
          }
          encode(encoder === 'h264_nvenc')
        })
    )
    .finally(() => {
      inFlight.delete(outPath)
      listeners.clear()
    })

  inFlight.set(outPath, { promise: task, listeners })
  return task
}

import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { execFile } from 'child_process'
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
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
import { measureWideAdvances } from './fontMetrics'
import { effectiveTransitionSeconds } from '@shared/transition'
import { targetResolution, textCanvasSize } from '@shared/resolution'
import { duckingFilterArgs } from '@shared/ducking'
import { normalizeFades } from '@shared/audioFade'
import { scaleToFrameFilter } from '@shared/videoFrame'
import { frameCountForDuration, targetFrameRate } from '@shared/frameRate'
import { pipMarginPx } from '@shared/pipLayout'
import { audioClipGain } from '@shared/audioGain'
import {
  isMonoChannelCount,
  isMultiChannelCount,
  monoUpmixFilter,
  multiChannelDownmixFilter
} from '@shared/audioUpmix'
import { describeFfmpegError } from './ffmpegError'
import { durationFromPacketCsv, finiteSeconds } from './mediaDuration'
import { needsPreviewProxy } from './previewProxyService'

export const ffmpegPath = (ffmpegStatic as unknown as string).replace(
  'app.asar',
  'app.asar.unpacked'
)
const ffprobePath = ffprobeStatic.path.replace('app.asar', 'app.asar.unpacked')

ffmpeg.setFfmpegPath(ffmpegPath)
ffmpeg.setFfprobePath(ffprobePath)

/**
 * コンテナが尺を持っていない素材の尺を、パケットの時刻から測る。
 *
 * デコードはしない(**復号すると5分の素材で3.7秒かかるが、パケットを読むだけなら
 * 0.16秒**)。索引の無いコンテナでは末尾へ飛べないので、どのみち全体を読むことになる。
 * ここへ来るのは尺の分からない素材だけなので、通常のファイルには一切影響しない。
 *
 * **ストリームを絞らない。** 尺はコンテナ全体の長さ＝一番遅くまで続くストリームの終端で、
 * 映像と音声のどちらが長いかは素材による(実測: 尺の無い mkv は映像 5.000 秒に対し
 * 音声 5.015 秒)。映像だけ見ると足りない分が切り落とされる。
 *
 * 測れなかったら `null`。**取り込みを失敗させる理由にはしない。**
 */
function measureDurationByScan(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', filePath],
      // 3時間の30fpsで約324,000行(8MB程度)。既定の1MBだと途中で切れる。
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : durationFromPacketCsv(stdout))
    )
  })
}

export function probeMedia(filePath: string): Promise<MediaProbeResult> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, async (err, data) => {
      // 生の失敗文は版数とビルド設定の羅列で、本当の原因は末尾の1行だけ。
      // ここで短い日本語に直す(呼び出し元ごとに try/catch を足さない)。
      if (err) return reject(describeFfmpegError(err))
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
      const videoCodec = videoStream?.codec_name ?? ''
      const audioCodec = audioStream?.codec_name ?? ''
      // `??` では防げない——`fluent-ffmpeg` は値が無いところに文字列 `'N/A'` を入れる
      // ので、`?? 0` は素通りして `Number('N/A')` = `NaN` が外へ出る(理由は mediaDuration.ts)。
      const declared =
        finiteSeconds(data.format.duration) ??
        finiteSeconds(videoStream?.duration) ??
        finiteSeconds(audioStream?.duration)
      const duration = declared ?? (await measureDurationByScan(filePath)) ?? 0
      resolve({
        duration,
        width: videoStream?.width ?? 0,
        height: videoStream?.height ?? 0,
        fps,
        hasAudio: Boolean(audioStream),
        hasVideo: Boolean(videoStream),
        videoCodec,
        audioCodec,
        needsPreviewProxy: needsPreviewProxy(
          videoCodec,
          audioCodec,
          Boolean(videoStream),
          Boolean(audioStream)
        )
      })
    })
  })
}

// Seeking at or past the end of a file makes ffmpeg emit no frame at all, and the
// caller then hit a raw `ENOENT ... /tmp/ve-thumb-xxx/thumb.jpg`. A time *inside* the
// media failed too: 19.999s of a 20s clip lands after the last frame's timestamp.
// Clamping to a point that always has a frame means "the end of this clip" returns its
// last frame instead of an error. autoFinish.ts previously worked around this locally
// with `total - 0.05` and a silent catch; the other five call sites had no guard, and
// the thumbnail panel aborted its whole candidate run on a single failed frame.
const SEEK_END_MARGIN = 0.1

function clampSeekSeconds(filePath: string, atSeconds: number): Promise<number> {
  return new Promise((resolve) => {
    if (!Number.isFinite(atSeconds) || atSeconds <= 0) return resolve(0)
    ffmpeg.ffprobe(filePath, (err, data) => {
      const duration = data?.format?.duration
      // Probe failure is not ours to report here — run with the original time so the
      // real ffmpeg error (missing file, unreadable codec) reaches the caller intact.
      if (err || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
        return resolve(atSeconds)
      }
      resolve(Math.min(atSeconds, Math.max(0, duration - SEEK_END_MARGIN)))
    })
  })
}

function readFrameFile(outFile: string): string {
  if (!existsSync(outFile)) {
    throw new Error('指定した位置のフレームを取得できませんでした')
  }
  return `data:image/jpeg;base64,${readFileSync(outFile).toString('base64')}`
}

export async function generateThumbnailDataUrl(
  filePath: string,
  atSeconds: number
): Promise<string> {
  const seekSeconds = await clampSeekSeconds(filePath, atSeconds)
  const dir = mkdtempSync(join(tmpdir(), 've-thumb-'))
  const outFile = join(dir, 'thumb.jpg')
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true })
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .on('error', (e) => {
        cleanup()
        reject(describeFfmpegError(e))
      })
      .on('end', () => {
        try {
          resolve(readFrameFile(outFile))
        } catch (e) {
          reject(e)
        } finally {
          cleanup()
        }
      })
      .screenshots({
        timestamps: [seekSeconds],
        filename: 'thumb.jpg',
        folder: dir,
        size: '320x?'
      })
  })
}

export async function generateFrameDataUrl(
  filePath: string,
  atSeconds: number,
  width: number,
  height: number,
  fillCrop?: boolean,
  cropCenter?: { x: number; y: number },
  blurBackground?: boolean
): Promise<string> {
  const seekSeconds = await clampSeekSeconds(filePath, atSeconds)
  const dir = mkdtempSync(join(tmpdir(), 've-frame-'))
  const outFile = join(dir, 'frame.jpg')
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true })
  const w = Math.round(width)
  const h = Math.round(height)
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .inputOptions([`-ss ${seekSeconds}`])
      .complexFilter([
        `[0:v]${scaleToFrameFilter(w, h, fillCrop, cropCenter, blurBackground)},setsar=1[v]`
      ])
      .outputOptions(['-map [v]', '-frames:v 1'])
      .output(outFile)
      .on('error', (e) => {
        cleanup()
        reject(describeFfmpegError(e))
      })
      .on('end', () => {
        try {
          resolve(readFrameFile(outFile))
        } catch (e) {
          reject(e)
        } finally {
          cleanup()
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
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true })
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
      .on('error', (e) => {
        cleanup()
        reject(describeFfmpegError(e))
      })
      .on('end', () => {
        try {
          const buf = readFileSync(outFile)
          resolve(`data:image/png;base64,${buf.toString('base64')}`)
        } catch (e) {
          reject(e)
        } finally {
          cleanup()
        }
      })
      .run()
  })
}

const SILENCE_NOISE_DB = -30
const SILENCE_MIN_DURATION = 0.5
/**
 * 素材の一番大きい音から、これだけ下を「無音」とみなす。
 *
 * `-30dB` の決め打ちだけだと、**小さく録音された素材では話している区間まで無音**になる
 * (実測: 音の最大が -44.1dB の素材で、無音カットの候補が**全域8.00秒の1件**になった。
 * 同じ構造で音量だけ大きい素材では正しく2件・2.00秒)。素材の音量は撮り方で何十dBも
 * 変わるので、絶対値だけで切ってはいけない——ハイライト検出が
 * 「最大からの相対でも切る」を採っているのと同じ理由。
 */
const SILENCE_RELATIVE_MARGIN_DB = 12
/**
 * しきい値をここより下げない。**`silencedetect` は約 -96dB より下を指定すると
 * 何も検出しなくなる**(実測: `-90dB` では検出できる素材が `-96.3dB` では0件。
 * デジタル無音ですら拾わない)。相対で下げた値をそのまま渡すと、極端に小さく
 * 録れた素材や全域が無音の素材で**候補が1件も出なくなる**。
 * 16bit PCM の量子化下限(-90.3dB)ともほぼ一致する。
 */
const SILENCE_FLOOR_DB = -90

/**
 * 区間の最大音量(dBFS)を測る。取れなければ null(音声が無い・解析できない)。
 * `silencedetect` のしきい値を素材に合わせるために先に1回だけ通す。
 */
function detectMaxVolumeDb(
  filePath: string,
  rangeStart: number,
  duration: number
): Promise<number | null> {
  return new Promise((resolve) => {
    let maxDb: number | null = null
    ffmpeg(filePath)
      .inputOptions([`-ss ${rangeStart}`, `-t ${duration}`])
      .outputOptions(['-vn', '-af volumedetect', '-f null'])
      .output('-')
      .on('stderr', (line: string) => {
        const m = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(line)
        if (m) {
          const v = Number(m[1])
          if (Number.isFinite(v)) maxDb = v
        }
      })
      // 測れなかったら従来の絶対値で進む。ここで失敗を投げると、無音検出そのものが
      // できなくなってしまう(本命の検出は次の pass で改めてエラーを報告する)。
      .on('error', () => resolve(null))
      .on('end', () => resolve(maxDb))
      .run()
  })
}

export async function detectSilence(
  filePath: string,
  rangeStart: number,
  rangeEnd: number
): Promise<SilenceRange[]> {
  const duration = rangeEnd - rangeStart
  const maxDb = await detectMaxVolumeDb(filePath, rangeStart, duration)
  // 従来の絶対値より**厳しい側にしか動かさない**(min)。大きく録れている素材では
  // 今までどおり -30dB で切り、小さく録れている素材だけ相対でしきい値が下がる。
  const noiseDb =
    maxDb === null
      ? SILENCE_NOISE_DB
      : Math.max(SILENCE_FLOOR_DB, Math.min(SILENCE_NOISE_DB, maxDb - SILENCE_RELATIVE_MARGIN_DB))

  return new Promise((resolve, reject) => {
    const ranges: SilenceRange[] = []
    let pendingStart: number | null = null

    ffmpeg(filePath)
      .inputOptions([`-ss ${rangeStart}`, `-t ${duration}`])
      // **映像をデコードさせない。** 1パス目(`detectMaxVolumeDb`)には最初から
      // 指定があるのに、本命のこちらには無く、**同じ関数の2つのパスで片方だけ**
      // 映像を全フレームデコード＆再エンコードしていた。
      // 実測(1920x1080・120秒): **5.17秒 → 0.14秒**。検出結果は同一。
      // `-vn` ではなく `-c:v copy` にする理由は `detectAudioLevels` と同じ
      // (音声が無い素材で出力ストリームが0本になり、生の英語の失敗に変わるため)。
      .outputOptions([
        '-c:v copy',
        `-af silencedetect=noise=${noiseDb}dB:d=${SILENCE_MIN_DURATION}`,
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
      .on('error', (err) => reject(describeFfmpegError(err)))
      .on('end', () => {
        if (pendingStart !== null) {
          ranges.push({ start: rangeStart + pendingStart, end: rangeEnd })
        }
        resolve(ranges)
      })
      .run()
  })
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

let currentExportCommand: ffmpeg.FfmpegCommand | null = null
let exportInProgress = false
let exportCancelRequested = false

// ffmpeg's atempo filter only accepts a rate between 0.5 and 2.0, so speeds outside
// that range have to be reached by chaining several instances. Clamping to the range
// (the previous behaviour) silently desynced every clip using the UI's 0.25x / 3x /
// 4x buttons: a 20s clip at 4x exported 5s of video against 10s of audio, and at
// 0.25x it was 80s of video against 40s of audio.
export function atempoChain(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) return 'atempo=1'
  const steps: number[] = []
  let remaining = speed
  while (remaining > 2) {
    steps.push(2)
    remaining /= 2
  }
  while (remaining < 0.5) {
    steps.push(0.5)
    remaining *= 2
  }
  steps.push(remaining)
  // Trailing float noise (atempo=1.0000000000000002) makes ffmpeg's filter parser
  // fussy and the graph unreadable in logs.
  return steps.map((s) => `atempo=${Number(s.toFixed(6))}`).join(',')
}

// 書き出す音声の形式。合流フィルタ(concat / acrossfade / amix / sidechaincompress)は
// libavfilter がグラフ全体で1つの形式に揃うよう交渉するので、枝の中に `aresample` の
// ような変換フィルタがあると「変換の少ない側」が採られる。その結果、**モノラルや
// 44.1kHz の素材が1本混ざっただけで、本編のステレオが黙ってモノラルに畳まれ、
// サンプルレートも道連れで落ちる**(実測: 48kHz ステレオの本編にモノラルのナレーションを
// 1本足すと出力が 44.1kHz・1ch になり、左だけに入れた音が中央に潰れた)。
// エラーも警告も出ないので、書き出しの尺だけ見ていると気付けない。
const OUTPUT_SAMPLE_RATE = 48000
const OUTPUT_CHANNEL_LAYOUT = 'stereo'
// 合流の手前で形式を固定して、交渉の余地を無くす。**音声の枝を足したら必ずこれを通す**
// (通し忘れた枝が1本あれば、そこからグラフ全体が引きずられる)。
const AUDIO_FORMAT = `aformat=sample_fmts=fltp:sample_rates=${OUTPUT_SAMPLE_RATE}:channel_layouts=${OUTPUT_CHANNEL_LAYOUT}`

// 映像も同じ理由で固定する。**形式の交渉は音声だけの話ではない。**
// `xfade` は yuv444p を好むため、4:2:0 の素材しか無いタイムラインでも、
// 繋ぎを「クロスフェード」にしただけでグラフ全体が 4:4:4 に引き上げられ、
// libx264 が **High 4:4:4 Predictive** で書き出す。エラーも警告も出ない。
// 実測(1280x720 の 4:2:0 素材2本を 480p で書き出し):
//   繋ぎなし        → High / yuv420p        971,468 bps
//   クロスフェード  → High 4:4:4 / yuv444p 1,213,027 bps (同じ絵で +25%)
//   さらにPiPを足す → High / yuv420p        982,998 bps (overlay が 4:2:0 に引き戻す)
// つまり**利用者が使った機能の組み合わせ次第で、成果物の画素形式が黙って変わる**。
// 4:4:4 はハードウェアデコーダや一般的な再生環境が扱えない profile で、
// 元素材に無い色差情報が増えるわけでもないので、ここで 4:2:0 に固定する。
// (`previewProxyService` は最初から `-pix_fmt yuv420p` を付けている。書き出しだけが素通しだった)
const VIDEO_FORMAT = 'format=yuv420p'

/**
 * 音声の枝の終端に置く形式固定。モノラルの素材だけ、`@shared/audioUpmix` の理由で
 * 等倍に直してから固定する。チャンネル数が分からない素材(ffprobe が答えなかった)は
 * 今までどおりの経路にする。
 */
function audioFormatFor(channels: number | undefined): string {
  if (isMonoChannelCount(channels)) {
    return `${monoUpmixFilter(OUTPUT_SAMPLE_RATE)},${AUDIO_FORMAT}`
  }
  // 3ch 以上は、出力を `fltp` で固定しているせいで畳み込みの正規化が外れている。
  // 明示して戻す(理由は `@shared/audioUpmix` の `multiChannelDownmixFilter`)。
  if (isMultiChannelCount(channels)) {
    return `${multiChannelDownmixFilter(OUTPUT_SAMPLE_RATE)},${AUDIO_FORMAT}`
  }
  return AUDIO_FORMAT
}

/**
 * クリップを置いた位置まで音声をずらす `adelay`。**チャンネル数によらず全部ずらす。**
 *
 * `adelay=1000|1000` は「1ch目を1000ms、2ch目を1000ms」という**チャンネルごとの**指定で、
 * 数が足りない残りのチャンネルは**既定でずらされない**(`all` の既定が 0)。
 * ステレオへ畳むのはこの後ろの `audioFormatFor` なので、`adelay` の時点では
 * **素材のチャンネル数のまま**——5.1ch の素材なら 3〜6ch目(センター・LFE・リア)だけが
 * **0秒地点から鳴り始める**。畳んだあとはステレオに混ざって出てくるので、
 * チャンネル数を気にしていない利用者からは「置いていない場所で音が鳴る」としか見えない。
 * エラーも警告も出ず、尺も音量も一見まともなまま。
 *
 * (実測: 全チャンネルに 1kHz を入れた 5.1ch の BGM を **2秒地点**に置いて書き出すと、
 *  無音のはずの 0〜2秒が **mean -39.8dB / max -34.8dB**。2ch の同じ素材は -91.0dB。
 *  1.0〜1.2秒だけビープを入れた 5.1ch では、鳴る区間が **1.00秒と3.00秒の2回**になり、
 *  ずれた4チャンネルが**2秒早いこだま**として重なっていた。直すと 3.00秒の1回だけ)
 *
 * `all=1` は「最後に書いた遅延を残りのチャンネル全部に使う」指定。チャンネル数を
 * 調べなくてよいので、**数が分からなかった素材でも取りこぼさない**。
 * 1ch・2ch では今までと同じ結果になる(余った `|` は元々無視されていた)。
 */
function adelayFilter(delayMs: number): string {
  return `adelay=${delayMs}:all=1`
}

/**
 * 素材の音声チャンネル数を調べる。**書き出しを止める理由にはしない**ので、
 * 失敗しても `undefined` を返す(呼び出し側が今までどおりの経路に倒す)。
 */
function probeAudioChannels(filePath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data) return resolve(undefined)
      const audio = data.streams.find((s) => s.codec_type === 'audio')
      const channels = audio?.channels
      resolve(typeof channels === 'number' && channels > 0 ? channels : undefined)
    })
  })
}

/** タイムラインが実際に使う音声素材だけを、パス単位で1回ずつ調べる。 */
async function probeUsedAudioChannels(project: Project): Promise<Map<string, number>> {
  const used = new Set<string>()
  const add = (assetId: string): void => {
    const asset = project.assets.find((a) => a.id === assetId)
    if (asset?.hasAudio) used.add(asset.filePath)
  }
  project.clips.forEach((c) => add(c.assetId))
  project.audioTracks.forEach((t) => t.clips.forEach((c) => add(c.assetId)))
  project.videoOverlayTracks.forEach((t) => t.clips.forEach((c) => add(c.assetId)))
  const paths = [...used]
  const results = await Promise.all(paths.map((p) => probeAudioChannels(p)))
  const map = new Map<string, number>()
  paths.forEach((p, i) => {
    const ch = results[i]
    if (ch !== undefined) map.set(p, ch)
  })
  return map
}

export function cancelExport(): void {
  if (!exportInProgress) return
  // Also covers the window before .run() assigns currentExportCommand: the flag
  // makes the in-flight job abort as soon as its command handle exists.
  exportCancelRequested = true
  currentExportCommand?.kill('SIGKILL')
}

export async function exportProject(options: ExportOptions): Promise<void> {
  const { project, aspectRatio, resolutionHeight, quality, outputPath, onProgress } = options
  const loudnessNormalization = options.loudnessNormalization ?? false
  const { w, h } = targetResolution(aspectRatio, resolutionHeight)
  const assetById = new Map(project.assets.map((a) => [a.id, a]))
  const clips = project.clips
  if (clips.length === 0) {
    return Promise.reject(new Error('タイムラインにクリップがありません'))
  }
  // The cancel handle and progress channel are singletons; a second concurrent
  // encode would overwrite currentExportCommand and leave the first job
  // uncancelable, with both jobs fighting over the one progress bar. The flag is
  // set synchronously here so two calls in the same tick can't both get through.
  if (exportInProgress) {
    return Promise.reject(
      new Error('別の書き出しが進行中です。完了またはキャンセルしてから再度お試しください')
    )
  }
  exportInProgress = true

  // 素材に合わせた出力フレームレート。畳み込み(concat/xfade)を通すため全クリップで共通。
  // **長さの丸めに使うので、長さより先に決める。**
  const outputFps = targetFrameRate(
    clips.map((c) => assetById.get(c.assetId)?.fps).filter((f): f is number => f !== undefined)
  )
  /** タイムライン(画面)の上での1本の長さ。テロップ・BGM の位置はこの秒で来る。 */
  const clipOutputDurations = clips.map((c) => (c.outPoint - c.inPoint) / (c.speed || 1))
  /**
   * **書き出しの中での1本の長さ。フレーム数から作り直す。**
   *
   * 映像は1本ぶんを `trim=end_frame=round(尺×fps)` で切るので、出来上がる長さは
   * **必ずフレームの整数倍**になる。ところが音声は `atrim=0:尺`、無音は
   * `anullsrc duration=尺` と**秒でそのまま**切っていた。尺がフレーム境界に
   * 乗っていないと1本ごとに最大 1/(2×fps) 秒(30fpsで16.7ms)の差が生まれ、
   * 映像と音声は**別々に `concat`** されるので、その差が**本数ぶん積み上がる**。
   * 尺が整数秒のときは差が 0 なので、手で置いたクリップでは一生出ない——
   * **境界が生の秒で来る経路**(無音カットは `silencedetect` の生値、フィラーカット・
   * テキスト編集・AI編集・長尺ショートも同じ)でだけ出る。
   * (実測: 2.345秒×10本で、映像 23.334秒(700フレーム)に対し音声 23.450秒。
   *  各クリップ先頭のビープが絵より **11.67ms ずつ遅れて積み上がり**、10本目で
   *  **117ms**。50断片なら約0.58秒、100断片なら約1.17秒になる)
   *
   * 同じ理由で、**テロップ・BGM・PiP を置く位置**(`exportStarts` → `toExportTime`)も
   * この長さで数える。ここだけ秒のままだと、後ろのクリップに紐づいた効果音が
   * 絵より遅れて鳴る(実測: 10本目の頭に置いた効果音が **105ms 遅れ**た)。
   *
   * 揃える先を**映像側**にするのは、出力が CFR で映像の枚数が動かせないから。
   * 1本あたりの調整は最大でも半フレームで、**積み上がらない**のがここの要点。
   */
  const clipExportDurations = clipOutputDurations.map(
    (d) => frameCountForDuration(d, outputFps) / outputFps
  )
  let totalDuration = clipExportDurations.reduce((sum, d) => sum + d, 0)
  // Where each clip begins on the app's timeline (clips laid back-to-back). A
  // crossfade overlaps two clips, so the exported video is shorter than this by the
  // transition duration — exportStarts below tracks the real output positions.
  // **こちらは画面の秒のまま**。`toExportTime` の入口は画面から来た秒なので、
  // ここをフレームに丸めると入口の目盛りが画面とずれる。
  const timelineStarts: number[] = []
  {
    let acc = 0
    for (const d of clipOutputDurations) {
      timelineStarts.push(acc)
      acc += d
    }
  }
  const exportStarts: number[] = new Array(clips.length).fill(0)
  exportCancelRequested = false
  // `exportInProgress` はここまでに同期で立っているので、同じ tick の2回目は上で弾かれる
  // (この await より前に立てておくのが条件)。調べるのは使う素材だけで、失敗しても
  // 例外にしない——書き出しがチャンネル数のせいで落ちるのは本末転倒。
  const audioChannelsByPath = await probeUsedAudioChannels(project)
  // テロップの折り返し幅は**見積もりではなく実測**で決める。libass に1度描かせて
  // 全角の送り幅を測る(結果はフォントごとに使い回すので、2回目以降は測らない)。
  // 上の probe と同じで、測れなくても例外にしない——折り返しが少し広いだけの話で、
  // 書き出せなくなるほうがはるかに悪い。
  const wideEmByFont = await measureWideAdvances(ffmpegPath, project.textOverlays)

  return new Promise((resolve, reject) => {
    let command: ffmpeg.FfmpegCommand
    let assDir: string | null = null
    const cleanupAssDir = (): void => {
      if (assDir) rmSync(assDir, { recursive: true, force: true })
    }
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
        // 枝の長さは**フレーム数から作り直したほう**を使う(映像・音声・無音のどれも
        // 同じ数から切るので、1本ごとの差が生まれない)。
        const outputDuration = clipExportDurations[i]
        command.input(asset.filePath).inputOptions([`-ss ${clip.inPoint}`, `-t ${sourceDuration}`])
        const myIndex = inputIndex++

        const scalePadFilter = scaleToFrameFilter(
          w,
          h,
          clip.fillCrop,
          clip.cropCenter,
          clip.blurBackground,
          { labelSuffix: String(i), fps: outputFps }
        )
        // `fps` は scaleToFrameFilter が中で付ける。ここで overlay の後ろに付けると
        // ぼかし背景のときだけ最後の1フレームが落ちる(関数側のコメント参照)。
        //
        // **映像も音声と同じく、尺ちょうどに揃えてから畳み込む。**
        //
        // 素材の映像ストリームは音声ストリームと同じ長さとは限らない。長さの判定に使う
        // `duration` は**コンテナ全体の長さ**なので、映像だけ先に終わる素材(末尾に音声だけが
        // 残る録画物)では、クリップの尺として渡した秒数ぶんの映像が**そもそも無い**。
        // 映像と音声は**別々に `concat`** して積み上げるので、足りない分が1本ごとに累積し、
        // **2本目以降の映像が音声より前へずれていく**。エラーも警告も出ない。
        // (実測: 映像4秒・音声5秒の素材を尺5秒で3本並べると、音声 15.000秒に対して
        //  映像 12.000秒(360フレーム)。音声のビープは 0/5/10秒と正しい位置なのに、
        //  映像は1本ごとに1秒ずつ先行し、最後の3秒は絵が無かった)
        // `tpad` で足りない分を**最後のフレームのまま**引き伸ばし、`trim` で長すぎる分を
        // 切る——音声側の `apad`+`atrim` と対になる、どちらの向きのズレも塞ぐ1本。
        // 切る長さは**秒ではなくフレーム数**で渡す。`trim=duration` は「表示時刻が
        // その秒数未満」の判定なので、`overlay`(ぼかし背景)を通って時間基準が細かく
        // なると、ちょうど境目にある1枚が丸めで滑り込んで**映像だけ1フレーム多くなる**
        // (実測: 20秒の書き出しで黒帯 600フレーム・20.000000秒に対し、ぼかし背景だけ
        //  601フレーム・20.033984秒)。フレーム数なら判定に時刻が入らないので、
        //  どの組み方でも同じ数になる(数え方は `frameCountForDuration`)。
        // **切ったあとは時刻を0へ寄せ直す。** `trim` は入力の時刻をそのまま通すので、
        // 切り出し位置がフレーム境界から少しでも外れていると(無音カットの境界は
        // `silencedetect` の生値なので必ずそうなる)、その枝の先頭フレームが
        // **pts 0 ではなく pts 1** から始まる。`concat` は前の枝の**終端の時刻**で
        // 次の枝をずらすので、枚数は合っているのに繋ぎ目ごとに**1フレームぶんの隙間**が空き、
        // CFR で詰めるエンコーダがそこを複製フレームで埋めて**映像だけ長くなる**。
        // (実測: 切り出し位置が 8.000068 秒だと枝の先頭が pts 1、8.0 秒ちょうどなら pts 0。
        //  6断片・合計750フレームのはずの書き出しが **754フレーム/25.133984秒**になり、
        //  音声 24.999秒と食い違っていた。境界に乗らない繋ぎ目が4つで、ちょうど +4枚)
        // 音声側は最初から `atrim` の後ろで `asetpts=PTS-STARTPTS` を通しており、
        // **ここでも片方にだけ揃える処理が育っていた**。
        //
        // 寄せ直しは**引き算ではなく、何枚目かから作り直す**(`settb`+`setpts=N`)。
        // `PTS-STARTPTS` の引き算だと入力の刻みがそのまま残るので、`overlay` を通って
        // 時間の刻みが細かくなる**ぼかし背景のときだけ**、格子から僅かに外れた時刻が
        // 残り、後段で**最後の1枚が同じ枠に潰れて消える**(実測: 120枚のはずが
        // **119枚/3.966992秒**)。枚数は `trim=end_frame` で確定済みなので、
        // 時刻は「n枚目 = n/30秒」と置き直してよく、どの組み方でも同じ格子に乗る。
        //
        // 置き直した後ろに `fps` を通すのは、絵を作り直すためではなく**コマ数の申告を
        // 戻すため**。`setpts` は時刻を自由に書き換えられる関係で、出口の
        // 「毎秒何コマか」を**未定**にしてしまう。未定のままエンコーダまで届くと
        // 既定の 25fps で書き出され、**出力全体が 25fps に化ける**
        // (実測: 750枚のはずが **626枚/25fps/25.040秒**)。時刻がちょうど格子に
        // 乗っているので、この `fps` は素通しで、枚数を増やしも減らしもしない。
        filterParts.push(
          `[${myIndex}:v]setpts=PTS/${speed},${scalePadFilter},setsar=1,` +
            `tpad=stop_duration=${outputDuration}:stop_mode=clone,` +
            `trim=end_frame=${frameCountForDuration(outputDuration, outputFps)},` +
            `settb=1/${outputFps},setpts=N,fps=${outputFps}[v${i}]`
        )
        if (asset.hasAudio && !clip.audioDetached) {
          // 音声も**映像と同じ尺ちょうど**に揃えてから畳み込む。
          //
          // 素材の音声ストリームは映像ストリームと同じ長さとは限らない(録画物では
          // 音声だけ数十ms〜数秒短いことがよくある)。クリップは映像と音声を
          // **別々に `concat`** して積み上げるので、1本ごとの差がそのまま累積し、
          // **2本目以降の音が前へずれていく**。エラーも警告も出ず、尺は映像側で
          // 決まるので「出力の長さは合っている」ように見える。
          // (実測: 映像5秒・音声4秒の素材を3本並べると、映像 15.000秒に対し
          //  音声 11.968秒。各クリップ先頭のビープが 0 / **3.99** / **7.98** 秒と、
          //  本来の 0 / 5 / 10 から最大 2.02 秒ずれていた。音声も5秒の素材でも
          //  AAC のフレーム境界のぶん 1本あたり約 0.02 秒ずれ、100本のジャンプカットなら
          //  2秒の音ズレになる)
          // `apad` で足りない分を無音で埋め、`atrim` で長すぎる分を切る——
          // **どちらの向きのズレも同じ1本で塞ぐ**。音声を持たないクリップは
          // 最初から `anullsrc` に `duration` を渡して尺ちょうどにしており、
          // ここでも**片方にだけ揃える処理が育っていた**。
          filterParts.push(
            `[${myIndex}:a]${atempoChain(speed)},aresample=async=1,asetpts=PTS-STARTPTS,` +
              `apad,atrim=0:${outputDuration},asetpts=PTS-STARTPTS,` +
              `${audioFormatFor(audioChannelsByPath.get(asset.filePath))}[a${i}]`
          )
        } else {
          filterParts.push(
            `anullsrc=channel_layout=${OUTPUT_CHANNEL_LAYOUT}:sample_rate=${OUTPUT_SAMPLE_RATE}:duration=${outputDuration},${AUDIO_FORMAT}[a${i}]`
          )
        }
      })

      // --- Fold clips together sequentially, applying transitions where set ---
      // 実効の長さは**画面と同じ関数**から出す(`@shared/transition`)。ここに数字を
      // 書くと、片方だけ動いて「画面では重なるのに書き出しでは切り替わる」に戻る。
      // A crossfade must be strictly shorter than both neighbors: xfade/acrossfade
      // reject a duration exceeding either input and abort the whole encode. When a
      // neighbor is too short (e.g. a tiny split fragment), it falls back to a hard cut.
      //
      // 渡すのは**書き出し側の尺**(`clipExportDurations`)。この関数が言う「隣より短く
      // しておいた」は、**渡した尺に対しての保証**でしかない。枝を1フレームに丸めて
      // 短くしたのに画面の秒を渡すと、`acrossfade` が受け取る1本目より繋ぎのほうが
      // 長くなり、**音声ストリームが丸ごと落ちた出力が、エラーも出さずに出来上がる**。
      // (実測: 0.0499秒×4本 + 5秒に1秒のフェード。画面の秒だと繋ぎ 0.1496秒に対して
      //  1本目の実長は 0.1333秒しかなく、出来上がった mp4 は**映像だけ**。書き出し側の
      //  尺を渡すと繋ぎ 0.0833秒 < 0.1333秒 に収まり、音声が付く)
      // 尺が整数秒なら両者は完全に同じ値なので、今までの出力は動かない。
      const transitionSeconds = effectiveTransitionSeconds(
        clipExportDurations,
        clips.map((c) => c.transitionIn)
      )
      let curV = 'v0'
      let curA = 'a0'
      // 畳み込みの累積も**書き出し側の長さ**で数える。`exportStarts` はこの累積から
      // 作られ、テロップ・BGM・PiP の位置(`toExportTime`)がここに乗る。
      let curDuration = clipExportDurations[0]
      for (let i = 1; i < clips.length; i++) {
        const clip = clips[i]
        const incomingDuration = clipExportDurations[i]
        const transition = clip.transitionIn
        const t = transitionSeconds[i]
        if (t <= 0 || !transition) {
          const outV = `vcat${i}`
          const outA = `acat${i}`
          filterParts.push(`[${curV}][v${i}]concat=n=2:v=1:a=0,settb=1/${outputFps}[${outV}]`)
          filterParts.push(`[${curA}][a${i}]concat=n=2:v=0:a=1[${outA}]`)
          curV = outV
          curA = outA
          exportStarts[i] = curDuration
          curDuration = curDuration + incomingDuration
        } else {
          const offset = Math.max(0, curDuration - t)
          const outV = `vxf${i}`
          const outA = `axf${i}`
          filterParts.push(
            `[${curV}][v${i}]xfade=transition=${xfadeName(transition.type)}:duration=${t}:offset=${offset},settb=1/${outputFps}[${outV}]`
          )
          filterParts.push(`[${curA}][a${i}]acrossfade=d=${t}[${outA}]`)
          curV = outV
          curA = outA
          exportStarts[i] = offset
          curDuration = curDuration + incomingDuration - t
        }
      }

      // Transitions overlap their two clips, so the output is shorter than the
      // timeline. Text overlays, audio-track clips and PiP clips are all anchored to
      // timeline seconds, so without this remap everything after the first
      // transition would be burned in / delayed by the accumulated overlap.
      const toExportTime = (timelineTime: number): number => {
        let idx = 0
        for (let i = 0; i < timelineStarts.length; i++) {
          if (timelineStarts[i] <= timelineTime) idx = i
          else break
        }
        return Math.max(0, timelineTime - (timelineStarts[idx] - exportStarts[idx]))
      }
      // The encoded video's real length; the raw timeline sum would stall progress short of 100%.
      totalDuration = curDuration

      // --- Video overlay tracks (PiP): scale + timestamp-shift + overlay onto the base video ---
      const pipAudioEntries: { label: string; duck: boolean }[] = []
      let pipCounter = 0
      project.videoOverlayTracks.forEach((track) => {
        if (track.hidden) return
        track.clips.forEach((overlayClip) => {
          const asset = assetById.get(overlayClip.assetId)
          if (!asset) return
          const dur = overlayClip.outPoint - overlayClip.inPoint
          if (dur <= 0) return
          command.input(asset.filePath).inputOptions([`-ss ${overlayClip.inPoint}`, `-t ${dur}`])
          const myIndex = inputIndex++
          const pipStart = toExportTime(overlayClip.startTime)
          const pipLabel = `pip${pipCounter}`
          const scaledWidth = Math.max(2, Math.round((w * track.scale) / 2) * 2)
          filterParts.push(
            `[${myIndex}:v]scale=${scaledWidth}:-2,setpts=PTS-STARTPTS+${pipStart}/TB[${pipLabel}]`
          )
          const margin = Math.round(pipMarginPx(w))
          const xExpr =
            track.position === 'top-left' || track.position === 'bottom-left'
              ? `${margin}`
              : `W-w-${margin}`
          const yExpr =
            track.position === 'top-left' || track.position === 'top-right'
              ? `${margin}`
              : `H-h-${margin}`
          const endTime = pipStart + dur
          const outV = `vpip${pipCounter}`
          filterParts.push(
            `[${curV}][${pipLabel}]overlay=x=${xExpr}:y=${yExpr}:enable='between(t\\,${pipStart}\\,${endTime})'[${outV}]`
          )
          curV = outV
          if (asset.hasAudio) {
            const delayMs = Math.max(0, Math.round(pipStart * 1000))
            const audioLabel = `pipaudio${pipCounter}`
            filterParts.push(
              `[${myIndex}:a]asetpts=PTS-STARTPTS,${adelayFilter(delayMs)},` +
                `${audioFormatFor(audioChannelsByPath.get(asset.filePath))}[${audioLabel}]`
            )
            pipAudioEntries.push({ label: audioLabel, duck: false })
          }
          pipCounter++
        })
      })

      let videoLabel = `[${curV}]`
      if (project.textOverlays.length > 0) {
        assDir = mkdtempSync(join(tmpdir(), 've-subs-'))
        const assPath = join(assDir, 'overlay.ass')
        const remappedOverlays = project.textOverlays.map((o) => ({
          ...o,
          startTime: toExportTime(o.startTime),
          endTime: toExportTime(o.endTime),
          words: o.words?.map((word) => ({
            ...word,
            start: toExportTime(word.start),
            end: toExportTime(word.end)
          }))
        }))
        // テロップの仮想キャンバスは**出力解像度ではなく固定の基準**。libass が
        // PlayRes から実フレームへ全体を拡大縮小するので、`\fs` や `MarginL/R` に
        // 入れた数字が解像度によらず「枠に対する比」になる(理由は textCanvasSize)。
        const textCanvas = textCanvasSize(aspectRatio)
        writeFileSync(
          assPath,
          buildAssContent(remappedOverlays, textCanvas.w, textCanvas.h, wideEmByFont),
          'utf-8'
        )
        filterParts.push(`[${curV}]subtitles=filename='${escapeFilterPath(assPath)}'[vout]`)
        videoLabel = '[vout]'
      }
      // 出力の直前で画素形式を固定する。ここが最後の砦なので、映像の枝を足しても消しても
      // 成果物の形式が変わらない(上の VIDEO_FORMAT のコメント参照)。
      filterParts.push(`${videoLabel}${VIDEO_FORMAT}[vfmt]`)
      videoLabel = '[vfmt]'

      // --- Extra audio tracks (BGM / narration) mixed on top of the main audio ---
      const perTrackAudio: { label: string; duck: boolean }[] = []
      project.audioTracks.forEach((track, trackIdx) => {
        if (track.muted) return
        const clipLabels: string[] = []
        track.clips.forEach((trackClip, clipIdx) => {
          const asset = assetById.get(trackClip.assetId)
          if (!asset) return
          const dur = trackClip.outPoint - trackClip.inPoint
          if (dur <= 0) return
          command.input(asset.filePath).inputOptions([`-ss ${trackClip.inPoint}`, `-t ${dur}`])
          const myIndex = inputIndex++
          const label = `atrk${trackIdx}_${clipIdx}`
          const delayMs = Math.max(0, Math.round(toExportTime(trackClip.startTime) * 1000))
          // 音量の式はプレビューと同じ共通モジュール(2箇所に書くと片方だけ育つ)。
          const clipVolume = audioClipGain(track.volume, trackClip.volume)
          // 分離音声は本編クリップの速度がミラーされている。ここで atempo を掛けないと
          // 映像だけ速くなって音が置き去りになる(atempoChain が 0.5〜2.0 の定義域を連鎖で吸収)。
          const clipSpeed = trackClip.speed || 1
          // atempo のあとの尺 = タイムライン上の尺。フェードはこの時間軸で掛ける。
          // asetpts でクリップ自身は0始まりに正規化されるので、フェードの位置に
          // toExportTime は通さない(絶対位置は adelay 側が既に通している)。
          const timelineDur = dur / clipSpeed
          const { fadeIn, fadeOut } = normalizeFades(
            trackClip.fadeIn,
            trackClip.fadeOut,
            timelineDur
          )
          const fadeParts: string[] = []
          if (fadeIn > 0) fadeParts.push(`afade=t=in:st=0:d=${fadeIn}`)
          if (fadeOut > 0) {
            fadeParts.push(`afade=t=out:st=${Math.max(0, timelineDur - fadeOut)}:d=${fadeOut}`)
          }
          const fadeChain = fadeParts.length > 0 ? `${fadeParts.join(',')},` : ''
          filterParts.push(
            `[${myIndex}:a]${atempoChain(clipSpeed)},asetpts=PTS-STARTPTS,${fadeChain}` +
              `volume=${clipVolume},${adelayFilter(delayMs)},` +
              `${audioFormatFor(audioChannelsByPath.get(asset.filePath))}[${label}]`
          )
          clipLabels.push(label)
        })
        if (clipLabels.length === 0) return
        let trackLabel = clipLabels[0]
        if (clipLabels.length > 1) {
          trackLabel = `atrkmix${trackIdx}`
          filterParts.push(
            `${clipLabels.map((l) => `[${l}]`).join('')}amix=inputs=${clipLabels.length}:duration=longest:dropout_transition=0:normalize=0[${trackLabel}]`
          )
        }
        perTrackAudio.push({ label: trackLabel, duck: track.duckingEnabled })
      })
      perTrackAudio.push(...pipAudioEntries)

      // Duck tracks flagged for ducking against the main video track's audio (voice/dialogue).
      const duckTracks = perTrackAudio.filter((t) => t.duck)
      let mainAudioForMix = curA
      if (duckTracks.length > 0) {
        const splitOutputs = [
          `[${curA}_mixcopy]`,
          ...duckTracks.map((_, i) => `[${curA}_duck${i}]`)
        ]
        filterParts.push(`[${curA}]asplit=${duckTracks.length + 1}${splitOutputs.join('')}`)
        mainAudioForMix = `${curA}_mixcopy`
        duckTracks.forEach((t, i) => {
          const duckedLabel = `${t.label}_ducked`
          filterParts.push(`[${t.label}][${curA}_duck${i}]${duckingFilterArgs()}[${duckedLabel}]`)
          t.label = duckedLabel
        })
      }

      const extraAudioLabels = perTrackAudio.map((t) => t.label)

      let audioLabel = `[${mainAudioForMix}]`
      if (extraAudioLabels.length > 0) {
        const mixInputs = [`[${mainAudioForMix}]`, ...extraAudioLabels.map((l) => `[${l}]`)].join(
          ''
        )
        filterParts.push(
          `${mixInputs}amix=inputs=${extraAudioLabels.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`
        )
        audioLabel = '[aout]'
      }

      if (loudnessNormalization) {
        // loudnorm は内部を 192kHz で回すため、後ろを固定しないと**出力が 96kHz になる**
        // (実測: 48kHz の素材が 96kHz で書き出されていた)。既定でONなので既定のまま
        // 書き出すと必ず踏む。ここでも形式を戻す。
        filterParts.push(`${audioLabel}loudnorm=I=-14:TP=-1.5:LRA=11,${AUDIO_FORMAT}[aloud]`)
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
        .on('error', (err) => {
          cleanupAssDir()
          currentExportCommand = null
          exportInProgress = false
          if (exportCancelRequested) {
            // 目印なのでそのまま(画面側が文字列で見分けている)
            rmSync(outputPath, { force: true })
            reject(new Error('EXPORT_CANCELED'))
          } else {
            reject(describeFfmpegError(err))
          }
        })
        .on('end', () => {
          cleanupAssDir()
          currentExportCommand = null
          exportInProgress = false
          onProgress(100, '完了')
          resolve()
        })
        .run()
      currentExportCommand = command
      // A cancel that arrived while the filter graph was still being built has no
      // command to kill yet, so honour it as soon as the handle exists.
      if (exportCancelRequested) command.kill('SIGKILL')
    } catch (e) {
      cleanupAssDir()
      currentExportCommand = null
      exportInProgress = false
      reject(e)
    }
  })
}

function timemarkToSeconds(timemark: string): number {
  const parts = timemark.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return Number(timemark) || 0
}

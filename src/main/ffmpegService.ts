import { trackProcess } from './liveProcesses'
import { colorMatchFilter } from '@shared/color/match'
import { loudnormApplyFilter, loudnormMeasureFilter, type LoudnessTarget } from '@shared/loudness'
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
import { telopConcatList, telopLayerImageCount, type TelopLayerPayload } from '@shared/telop/layer'
import { materializeTelopLayer } from './telopLayerStage'
import { measureWideAdvances } from './fontMetrics'
import { computeMainTrackLayout } from '@shared/mainTrackLayout'
import { createExportTimeMap } from '@shared/exportTimeline'
import { targetResolution, textCanvasSize } from '@shared/resolution'
import { duckingFilterArgs, isMainVoiceClip } from '@shared/ducking'
import { normalizeFades } from '@shared/audioFade'
import { SQUARE_PIXEL_FILTER, scaleToFrameFilter, thumbnailScaleFilter } from '@shared/videoFrame'
import {
  frameCountForDuration,
  rateExpr,
  rateTimeBase,
  rateValue,
  targetRate
} from '@shared/frameRate'
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
export const ffprobePath = ffprobeStatic.path.replace('app.asar', 'app.asar.unpacked')

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

/**
 * 画素の縦横比(SAR)。分からない値・壊れた値は 1(正方形)として扱う。
 *
 * `ffprobe` は分からないとき `'0:1'` を返し、`fluent-ffmpeg` は項目が無いところに
 * 文字列 `'N/A'` を入れる。どちらも「比」として使うと 0 や NaN になり、
 * 掛けた先の幅が消える。**`SQUARE_PIXEL_FILTER` の `if(gt(sar,0),sar,1)` と同じ規則**。
 */
function pixelAspectRatio(stream: Record<string, unknown> | undefined): number {
  const raw = stream?.sample_aspect_ratio
  if (typeof raw !== 'string') return 1
  const [num, den] = raw.split(':').map(Number)
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return 1
  return num / den
}

/**
 * 素材の**画面に出る寸法**。画素が正方形でなければ幅を伸ばし、回転が付いていれば縦横を入れ替える。
 *
 * スマホの縦撮りは、中身が `1920x1080` のまま「表示するときに90度回す」という
 * 情報(display matrix)を持っている形が普通。`ffprobe` の `width`/`height` は
 * **回す前の数字**なので、そのまま持つと縦の素材を横だと思い込む。
 * ffmpeg も Chromium の `<video>` も**回してから**絵を出すので、
 * 実際に見えている絵とアプリが持っている数字だけが食い違う。
 *
 * (実測: 回転90度を付けた素材で `ffprobe` は **640x360**、しかし ffmpeg が出す1枚も
 *  プレビューの `videoWidth/videoHeight` も **360x640**。この 640x360 が
 *  `asset.width/height` に入るため、16:9 の企画で「クロップして画面いっぱい」に
 *  すると、`cropObjectPosition` が「縦横比が同じ＝はみ出さない」と判断して
 *  切り抜き位置を **50% 50%** に固定していた。書き出しは回した絵を切るので
 *  指定どおり上端が出る——**同じ設定で画面と出力に別の場所が映る**。
 *  実測の色: 書き出しは上下とも青(0,0,255)＝上端、画面は下側が赤(254,0,0)＝中央)
 *
 * 寸法を使っているのは**全部「見えている絵」を欲しがっている側**
 * (切り抜き位置の計算・トリムのモーダル・縦横比の警告・一覧の表示)なので、
 * 入口のここで直す。書き出しは寸法ではなくフィルタで組み立てているので影響しない。
 *
 * **回転と同じことが画素の縦横比(SAR≠1)でも起きる。** `ffprobe` の `width` は
 * 「符号化されている画素数」で、`SAR 2:1` の `640x360` は横に2倍伸ばして
 * `1280x360`(32:9)として見せる決まり。書き出しは `SQUARE_PIXEL_FILTER` で
 * 伸ばしてから切り、Chromium も DAR を見て伸ばした絵を出すので、
 * **アプリが持っている数字だけが伸ばす前のまま**になる。
 * (実測: `SAR 2:1` の `640x360` を 16:9 の企画で「クロップして画面いっぱい」にし、
 *  切り抜き位置を右寄り 0.75 にすると——`probeMedia` は **640x360**、
 *  プレビューの `videoWidth/videoHeight` は **1280x360**。
 *  アプリの数字だと縦横比が 1.778 で出力枠と同じになるため `cropObjectPosition` が
 *  「はみ出さない＝動かしようが無い」と判断し、`object-position` が
 *  **50% 50% に固定**される。8色の縦縞を並べた素材で、画面には中央の
 *  黄・緑・水色・青が出るのに、書き出しは指定どおり右端の水色・青・紫・白。
 *  **切り抜き位置のつまみを動かしても画面が一切動かない**——0.0/0.5/0.75/1.0 の
 *  どれでも 50% 50%。直すと 0%/50%/100%/100% と動き、画面と書き出しが一致する)
 */
function displayDimensions(stream: Record<string, unknown> | undefined): {
  width: number
  height: number
} {
  const coded = typeof stream?.width === 'number' ? stream.width : 0
  const height = typeof stream?.height === 'number' ? stream.height : 0
  // 伸ばすのは**幅**。`SQUARE_PIXEL_FILTER`(`scale='iw*sar':ih`)と同じ向きに揃える。
  const width = Math.round(coded * pixelAspectRatio(stream))
  // 新しい ffprobe は display matrix を `rotation`(数値)で、古い形は
  // `tags.rotate`(文字列)で出す。符号や 90/270 の別は入れ替えの判定に要らない
  // ——**奇数倍の90度かどうか**だけ見る。
  const tags = stream?.tags as { rotate?: unknown } | undefined
  const raw =
    typeof stream?.rotation === 'number'
      ? stream.rotation
      : typeof tags?.rotate === 'string'
        ? Number(tags.rotate)
        : 0
  const degrees = Number.isFinite(raw) ? Math.abs(raw) % 180 : 0
  return degrees === 90 ? { width: height, height: width } : { width, height }
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
      const display = displayDimensions(videoStream as Record<string, unknown> | undefined)
      resolve({
        duration,
        width: display.width,
        height: display.height,
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
  // `.screenshots({ size: '320x?' })` は使わない。`?` の高さを**符号化された画素数**から
  // 出すので、画素が正方形でない素材だけ縦横比が変わる(理由と実測は thumbnailScaleFilter)。
  // 組み立ては下の `generateFrameDataUrl` と同じ形にそろえる。
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .inputOptions([`-ss ${seekSeconds}`])
      .complexFilter([`[0:v]${thumbnailScaleFilter()}[v]`])
      .outputOptions(['-map [v]', '-frames:v 1'])
      .output(outFile)
      .on('error', (e, _stdout, stderr) => {
        cleanup()
        reject(describeFfmpegError(e, stderr))
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
      .on('error', (e, _stdout, stderr) => {
        cleanup()
        reject(describeFfmpegError(e, stderr))
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
      .on('error', (e, _stdout, stderr) => {
        cleanup()
        reject(describeFfmpegError(e, stderr))
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
      .on('error', (err, _stdout, stderr) => reject(describeFfmpegError(err, stderr)))
      .on('end', () => {
        if (pendingStart !== null) {
          ranges.push({ start: rangeStart + pendingStart, end: rangeEnd })
        }
        resolve(ranges)
      })
      .run()
  })
}

export function crfForQuality(quality: QualityPreset): number {
  switch (quality) {
    case 'high':
      return 18
    case 'small':
      return 28
    default:
      return 22
  }
}

/**
 * フィルターに渡すファイルの名前(引用符で囲まずに、そのまま `m=` や `filename=` の後ろに置く)。
 * フィルターの値は2段で読まれる(フィルター全体の区切り → フィルターの中の値の区切り)ので、
 * それぞれの段で意味のある文字に印を付ける。引用符で囲む書き方は、名前に `'` があると壊れていた
 * (例: C:\\Users\\O'Brien\\… のノイズ除去が必ず失敗する。実測で `'`・空白・和文・`,;[]%`・`C:` を確認)
 */
export function escapeFilterPath(p: string): string {
  const inner = p.replace(/\\/g, '/').replace(/[\\':]/g, '\\$&')
  return inner.replace(/[\\'[\],;]/g, '\\$&')
}

export function xfadeName(type: TransitionType): string {
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
  /** 音量の基準。既定は配信(-14 LUFS) */
  loudnessTarget?: LoudnessTarget
  /**
   * 画面のプロセスが共通レンダラ(`drawTelop`)で描いたテロップの層。
   * あればこれを重ね、ASS は使わない(画面と同じ絵になる)。
   * `null` は「描いた結果、出すテロップが無かった」なので何も焼かない。
   * 渡されないとき(`undefined`)だけ、従来の ASS で焼く。
   */
  telopLayer?: TelopLayerPayload | null
  onProgress: (percent: number, stage: string) => void
}

let currentExportCommand: ffmpeg.FfmpegCommand | null = null

/** アプリを閉じたら書き出しの ffmpeg も止める(終わったら一覧から外す) */
function trackExportCommand(command: ffmpeg.FfmpegCommand): void {
  const untrack = trackProcess(command)
  command.on('end', untrack).on('error', untrack)
}
let exportInProgress = false
let exportCancelRequested = false
/**
 * ffmpeg に渡す秒。`0.25 - 0.25` の丸めの残り(5.55e-17)のような値を JavaScript は指数で書き、
 * ffmpeg の `-ss`・`atrim` は読めずに書き出しごと失敗する。小数6桁で書く
 */
export function ffSeconds(sec: number): string {
  const v = Number.isFinite(sec) ? Math.max(0, sec) : 0
  return v < 5e-7 ? '0' : v.toFixed(6)
}
/** 本編の素材を切り出しの頭より少し手前から読む長さ(素材の秒)。1つ前の絵を読み込むため */
const MAIN_PREROLL_SEC = 0.25

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

/**
 * 音声の速度を変えるフィルタ。**ごく小さな速度の違い(録音機の時計のずれの補正)は atempo を使わない。**
 *
 * atempo は音程を保つために波形を細かく切ってつなぎ直す(WSOLA)ので、つなぎ目で数十ms
 * タイミングが揺れる。速度 1.0000625(時計のずれ 62.5ppm)を掛けると、本来の位置から
 * **18〜24ms** ずれ、ほかのマイクと重ねると声が二重(やまびこ)に聞こえた。
 * ずれの補正は「サンプル周波数を読み替える」だけで済む(音程は 0.2% 以下の違いなので聞き分けられない)。
 * 同じ素材で測ると、読み替えなら位置の誤差は 0.13ms 以下だった。
 *
 * 読み替えの周波数は整数しか指定できないので、960kHz に上げてから読み替える(誤差 0.5ppm 以下)。
 */
export const RESAMPLE_SPEED_LIMIT = 0.002
const RESAMPLE_GRID_RATE = 960000

export function audioSpeedChain(speed: number): string {
  // 等倍なら何も掛けない。atempo=1 でも素通しにはならず、同じく切ってつなぎ直すので
  // 音が 19〜26ms 遅れて揺れていた(実測: 30fps の映像に対して口の動きより音が遅れる)
  // 壊れた値(NaN・0 以下)も等倍として扱う
  if (speed === 1 || !Number.isFinite(speed) || speed <= 0) return 'anull'
  if (Math.abs(speed - 1) > RESAMPLE_SPEED_LIMIT) {
    return atempoChain(speed)
  }
  return (
    `aresample=${RESAMPLE_GRID_RATE},asetrate=${Math.round(RESAMPLE_GRID_RATE * speed)},` +
    `aresample=${OUTPUT_SAMPLE_RATE}`
  )
}

// 書き出す音声の形式。合流フィルタ(concat / acrossfade / amix / sidechaincompress)は
// libavfilter がグラフ全体で1つの形式に揃うよう交渉するので、枝の中に `aresample` の
// ような変換フィルタがあると「変換の少ない側」が採られる。その結果、**モノラルや
// 44.1kHz の素材が1本混ざっただけで、本編のステレオが黙ってモノラルに畳まれ、
// サンプルレートも道連れで落ちる**(実測: 48kHz ステレオの本編にモノラルのナレーションを
// 1本足すと出力が 44.1kHz・1ch になり、左だけに入れた音が中央に潰れた)。
// エラーも警告も出ないので、書き出しの尺だけ見ていると気付けない。
export const OUTPUT_SAMPLE_RATE = 48000
const OUTPUT_CHANNEL_LAYOUT = 'stereo'
// 合流の手前で形式を固定して、交渉の余地を無くす。**音声の枝を足したら必ずこれを通す**
// (通し忘れた枝が1本あれば、そこからグラフ全体が引きずられる)。
export const AUDIO_FORMAT = `aformat=sample_fmts=fltp:sample_rates=${OUTPUT_SAMPLE_RATE}:channel_layouts=${OUTPUT_CHANNEL_LAYOUT}`

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
export const VIDEO_FORMAT = 'format=yuv420p'

/**
 * 音声の枝の終端に置く形式固定。モノラルの素材だけ、`@shared/audioUpmix` の理由で
 * 等倍に直してから固定する。チャンネル数が分からない素材(ffprobe が答えなかった)は
 * 今までどおりの経路にする。
 */
export function audioFormatFor(channels: number | undefined): string {
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
export function adelayFilter(delayMs: number): string {
  return `adelay=${delayMs}:all=1`
}

/**
 * 素材の音声チャンネル数を調べる。**書き出しを止める理由にはしない**ので、
 * 失敗しても `undefined` を返す(呼び出し側が今までどおりの経路に倒す)。
 */
export function probeAudioChannels(filePath: string): Promise<number | undefined> {
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

/** 別の方式の書き出し(`runExclusiveExport`)が走っているときの中断の入口 */
let externalExportAbort: AbortController | null = null

/**
 * 従来の書き出しと**同じ排他・同じキャンセル**の下で、別の方式の書き出しを走らせる。
 * 進捗の通知先とキャンセルのボタンは1つしかないので、方式が違っても同時には走らせない。
 * キャンセルされたら `EXPORT_CANCELED`(画面が文字列で見分けている目印)で失敗させる。
 */
export async function runExclusiveExport<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (exportInProgress) {
    throw new Error('別の書き出しが進行中です。完了またはキャンセルしてから再度お試しください')
  }
  exportInProgress = true
  const controller = new AbortController()
  externalExportAbort = controller
  try {
    return await run(controller.signal)
  } catch (e) {
    if (controller.signal.aborted) throw new Error('EXPORT_CANCELED')
    throw e
  } finally {
    externalExportAbort = null
    exportInProgress = false
  }
}

export function cancelExport(): void {
  if (!exportInProgress) return
  if (externalExportAbort) {
    externalExportAbort.abort()
    return
  }
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
  // 29.97 などの素材は 30000/1001 のまま書き出す(整数に丸めると、約 1000 コマに1コマ同じ絵が重なる)
  const outputRate = targetRate(
    clips.map((c) => assetById.get(c.assetId)?.fps).filter((f): f is number => f !== undefined)
  )
  const outputFps = rateValue(outputRate)
  /** ffmpeg に渡すレート(`30000/1001`)と、1コマの時間の基準(`1001/30000`) */
  const fpsArg = rateExpr(outputRate)
  const frameTb = rateTimeBase(outputRate)
  /** タイムライン(画面)の上での1本の長さ。テロップ・BGM の位置はこの秒で来る。 */
  // 位置と尺の数え方は `computeMainTrackLayout` に1つだけ置く(v2 への移行も同じ関数を使う)。
  const mainLayout = computeMainTrackLayout(clips, outputFps)
  const clipOutputDurations = mainLayout.timelineDurations
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
  const clipExportDurations = mainLayout.exportDurations
  let totalDuration = clipExportDurations.reduce((sum, d) => sum + d, 0)
  // Where each clip begins on the app's timeline (clips laid back-to-back). A
  // crossfade overlaps two clips, so the exported video is shorter than this by the
  // transition duration — exportStarts below tracks the real output positions.
  // **こちらは画面の秒のまま**。`toExportTime` の入口は画面から来た秒なので、
  // ここをフレームに丸めると入口の目盛りが画面とずれる。
  const timelineStarts = mainLayout.timelineStarts
  const exportStarts = mainLayout.exportStarts
  exportCancelRequested = false
  // `exportInProgress` はここまでに同期で立っているので、同じ tick の2回目は上で弾かれる
  // (この await より前に立てておくのが条件)。調べるのは使う素材だけで、失敗しても
  // 例外にしない——書き出しがチャンネル数のせいで落ちるのは本末転倒。
  const audioChannelsByPath = await probeUsedAudioChannels(project)
  // テロップの折り返し幅は**見積もりではなく実測**で決める。libass に1度描かせて
  // 全角の送り幅を測る(結果はフォントごとに使い回すので、2回目以降は測らない)。
  // 上の probe と同じで、測れなくても例外にしない——折り返しが少し広いだけの話で、
  // 書き出せなくなるほうがはるかに悪い。
  // 層を受け取ったときは ASS を作らないので、測る必要も無い(測ると ffmpeg を1回余計に起こす)
  const usesTelopLayer = options.telopLayer !== undefined
  const telopLayer =
    options.telopLayer && telopLayerImageCount(options.telopLayer) > 0 ? options.telopLayer : null
  const wideEmByFont = usesTelopLayer
    ? new Map<string, number>()
    : await measureWideAdvances(ffmpegPath, project.textOverlays)

  /**
   * フィルタグラフの組み立て。**本番の書き出しと、ラウドネス測定パスの2回呼ばれる。**
   *
   * 測定パス(`includeVideo = false`)は入力と音声の枝を本番と**同じ順序・同じ引数**で
   * 組み、映像の枝だけを持たない。別々に書くと、測る音と書き出す音が黙ってズレる
   * (2パス化の前提は「書き出すのと同じ音を測る」こと)。入力の並びも共有する——
   * PiP の「丸ごと外なら入力に足さない」判定まで同じでないと、入力番号がずれて
   * 別のファイルを測ることになる。
   */
  const buildGraph = (
    command: ffmpeg.FfmpegCommand,
    includeVideo: boolean,
    /** テロップの層の concat 一覧(書き出し済みのファイル)。あれば ASS の代わりに重ねる */
    telopListPath: string | null = null
  ): { filterParts: string[]; videoLabel: string; audioLabel: string; assDir: string | null } => {
    {
      const filterParts: string[] = []
      let inputIndex = 0
      let assDir: string | null = null

      // --- Main video track: per-clip decode + scale/pad + speed ---
      clips.forEach((clip, i) => {
        const asset = assetById.get(clip.assetId)
        if (!asset) throw new Error(`アセットが見つかりません: ${clip.assetId}`)
        const speed = clip.speed || 1
        const sourceDuration = clip.outPoint - clip.inPoint
        // 枝の長さは**フレーム数から作り直したほう**を使う(映像・音声・無音のどれも
        // 同じ数から切るので、1本ごとの差が生まれない)。
        const outputDuration = clipExportDurations[i]
        // 少し手前から読む(長尺向けの書き出しの `addMediaInput` と同じ)。切り出しの頭が素材の
        // フレームの間にあると、頭で見えているはずの1つ前の絵が読み込まれず、最初の1コマだけ
        // 次の絵が出ていた。絵も音も、手前のぶんを時刻のずらし・切り落としで戻す
        const pre = Math.min(Math.max(0, clip.inPoint), MAIN_PREROLL_SEC)
        const preOut = pre / speed
        command
          .input(asset.filePath)
          .inputOptions([
            `-ss ${ffSeconds(clip.inPoint - pre)}`,
            `-t ${ffSeconds(sourceDuration + pre)}`
          ])
        const myIndex = inputIndex++
        // 音は手前から読まない(別の入力で、切り出しの頭から読む)。音と絵の頭がそろっていない素材
        // (絵が数フレーム遅れて始まる録画など)では、手前から読むと音の頭の位置がずれ、
        // 切り落としたあと音が絵より先に出ていた
        let audioIndex = myIndex
        if (pre > 0 && asset.hasAudio && !clip.audioDetached) {
          command
            .input(asset.filePath)
            .inputOptions([`-ss ${ffSeconds(clip.inPoint)}`, `-t ${ffSeconds(sourceDuration)}`])
          audioIndex = inputIndex++
        }

        // カメラ間の色合わせ(縮める前の画に掛ける)
        const colorPart = asset.colorMatch ? `${colorMatchFilter(asset.colorMatch)},` : ''
        const scalePadFilter = scaleToFrameFilter(
          w,
          h,
          clip.fillCrop,
          clip.cropCenter,
          clip.blurBackground,
          { labelSuffix: String(i), fps: fpsArg }
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
        if (includeVideo) {
          filterParts.push(
            `[${myIndex}:v]setpts=PTS/${speed}${preOut > 0 ? `-${preOut}/TB` : ''},${colorPart}${scalePadFilter},setsar=1,` +
              `tpad=stop_duration=${outputDuration}:stop_mode=clone,` +
              `trim=end_frame=${frameCountForDuration(outputDuration, outputFps)},` +
              `settb=${frameTb},setpts=N,fps=${fpsArg}[v${i}]`
          )
        }
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
            `[${audioIndex}:a]${audioSpeedChain(speed)},aresample=async=1,asetpts=PTS-STARTPTS,` +
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
      const transitionSeconds = mainLayout.transitionSeconds
      let curV = 'v0'
      let curA = 'a0'
      // 畳み込みの位置(`exportStarts`)と累積の尺は `computeMainTrackLayout` が
      // **書き出し側の長さ**で数え済み。テロップ・BGM・PiP の位置(`toExportTime`)も
      // 同じ値に乗る。ここではその位置どおりにフィルタを並べるだけにする。
      for (let i = 1; i < clips.length; i++) {
        const clip = clips[i]
        const transition = clip.transitionIn
        const t = transitionSeconds[i]
        if (t <= 0 || !transition) {
          const outV = `vcat${i}`
          const outA = `acat${i}`
          if (includeVideo) {
            filterParts.push(`[${curV}][v${i}]concat=n=2:v=1:a=0,settb=${frameTb}[${outV}]`)
          }
          filterParts.push(`[${curA}][a${i}]concat=n=2:v=0:a=1[${outA}]`)
          curV = outV
          curA = outA
        } else {
          const offset = exportStarts[i]
          const outV = `vxf${i}`
          const outA = `axf${i}`
          if (includeVideo) {
            filterParts.push(
              `[${curV}][v${i}]xfade=transition=${xfadeName(transition.type)}:duration=${t}:offset=${offset},settb=${frameTb}[${outV}]`
            )
          }
          filterParts.push(`[${curA}][a${i}]acrossfade=d=${t}[${outA}]`)
          curV = outV
          curA = outA
        }
      }

      // Transitions overlap their two clips, so the output is shorter than the
      // timeline. Text overlays, audio-track clips and PiP clips are all anchored to
      // timeline seconds, so without this remap everything after the first
      // transition would be burned in / delayed by the accumulated overlap.
      // 換算の規則は共通の置き場(`@shared/exportTimeline`)に1つだけ置く。
      // ここに書くと単体で確かめられず(このファイルは electron を引く経路を持つ)、
      // 「区間の両端を対で換算する」という決まりも**呼び出し側の作法**になってしまう。
      const { toExportTime, toExportEndTime } = createExportTimeMap(
        timelineStarts,
        clipOutputDurations,
        exportStarts
      )
      // The encoded video's real length; the raw timeline sum would stall progress short of 100%.
      totalDuration = mainLayout.totalExportDuration

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
          const pipStart = toExportTime(overlayClip.startTime)
          // **本編より後ろへはみ出したぶんは、graph へ渡す前に切る。**
          //
          // `overlay` は入力が**全部**終わるまで出力を続ける(framesync の既定は
          // `shortest=0`)。本編が先に終わると、その**最後の1枚が凍ったまま**
          // PiP の残りぶん引き伸ばされ、**出力が本編の尺より長くなる**。
          // 音声側は `amix` の `duration=first` で本編の尺に収まるので、
          // **映像と音声のストリーム長が食い違った mp4** が、エラーも警告も無く出来上がる。
          // (実測: 本編5秒の企画に 3.0秒から4秒の PiP を置くと、映像 **7.000秒/210枚**・
          //  音声 **5.000秒**。5〜7秒は本編の最後の1枚が凍ったまま PiP だけが動き、
          //  その2秒間の実効値は **0.00101**＝ほぼ無音だった)
          //
          // テロップは尺を超えたぶんが単に描かれないだけなので、PiP も同じ扱いに揃える。
          // `totalDuration` はこの直前に本編の実尺で確定しているので、それを上限にする。
          const pipVisibleDuration = Math.min(dur, totalDuration - pipStart)
          if (pipVisibleDuration <= 0) return
          /**
           * **PiP の終わり(書き出しの秒)。絵と音の両方がここで終わる。**
           *
           * 繋ぎに食われたぶんを詰めた終わり(`toExportEndTime`)を、本編の尺で
           * 頭打ちにしたもの。繋ぎをまたがない PiP では `pipStart + dur` と
           * 完全に同じ値になるので、今までの書き出しは1バイトも変わらない。
           */
          const pipEndExport = Math.min(
            toExportEndTime(overlayClip.startTime, overlayClip.startTime + dur),
            totalDuration
          )
          const pipAudibleDur = Math.max(0, Math.min(pipVisibleDuration, pipEndExport - pipStart))
          // 動画は本編と同じく少し手前から読み、頭の1コマも正しい絵にする(音は別の入力で頭から)
          const pipPre = asset.still
            ? 0
            : Math.min(Math.max(0, overlayClip.inPoint), MAIN_PREROLL_SEC)
          command.input(asset.filePath).inputOptions(
            // 静止画は同じ画を、書き出しのフレームレートで必要な秒数ぶん流す
            asset.still
              ? ['-loop 1', `-framerate ${fpsArg}`, `-t ${ffSeconds(pipVisibleDuration)}`]
              : [
                  `-ss ${ffSeconds(overlayClip.inPoint - pipPre)}`,
                  `-t ${ffSeconds(pipVisibleDuration + pipPre)}`
                ]
          )
          const myIndex = inputIndex++
          let pipAudioIndex = myIndex
          if (pipPre > 0 && asset.hasAudio) {
            command
              .input(asset.filePath)
              .inputOptions([
                `-ss ${ffSeconds(overlayClip.inPoint)}`,
                `-t ${ffSeconds(pipVisibleDuration)}`
              ])
            pipAudioIndex = inputIndex++
          }
          // 絵の出入りはフレームの格子に揃え、窓は半フレームずらして取る(長尺向けの書き出しと同じ)。
          // `between` は終わりの時刻を含むので、そのままだと終わりの1枚に PiP が残り、
          // 格子に乗らない頭では1枚遅れて出て、絵も最大1フレーム遅れていた
          const pipFirstFrame = Math.round(pipStart * outputFps)
          const pipEndFrame = Math.round(pipEndExport * outputFps)
          const pipFrameStart = pipFirstFrame / outputFps
          if (includeVideo && pipEndFrame > pipFirstFrame) {
            const pipLabel = `pip${pipCounter}`
            const scaledWidth = Math.max(2, Math.round((w * track.scale) / 2) * 2)
            const full = track.position === 'full'
            filterParts.push(
              // PiP も**画素を正方形に直してから**幅を決める。`scale=幅:-2` は
              // `iw/ih` から高さを出すので、SAR≠1 の素材はここでも縦長に潰れる。
              // 全面(版面CG)は縦横比を保って画面に収める。透過(アルファ)はそのまま overlay へ渡る
              // 色合わせもプレビュー・本編と同じく当てる(ワイプのカメラだけ補正前の色で出ていた)
              `[${myIndex}:v]${asset.colorMatch ? `${colorMatchFilter(asset.colorMatch)},` : ''}${SQUARE_PIXEL_FILTER},` +
                (full
                  ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,`
                  : `scale=${scaledWidth}:-2,`) +
                (pipPre > 0
                  ? `setpts=PTS-${ffSeconds(pipPre)}/TB+${ffSeconds(pipFrameStart)}/TB[${pipLabel}]`
                  : `setpts=PTS-STARTPTS+${ffSeconds(pipFrameStart)}/TB[${pipLabel}]`)
            )
            const margin = Math.round(pipMarginPx(w))
            const xExpr = full
              ? '(W-w)/2'
              : track.position === 'top-left' || track.position === 'bottom-left'
                ? `${margin}`
                : `W-w-${margin}`
            const yExpr = full
              ? '(H-h)/2'
              : track.position === 'top-left' || track.position === 'top-right'
                ? `${margin}`
                : `H-h-${margin}`
            // 見せる区間の終わりは `pipEndExport`(繋ぎに食われたぶんを詰め、
            // 本編の尺で頭打ちにした終わり)。音の枝も同じ値で切る。
            const enableFrom = ((pipFirstFrame - 0.5) / outputFps).toFixed(6)
            const enableTo = ((pipEndFrame - 0.5) / outputFps).toFixed(6)
            const outV = `vpip${pipCounter}`
            filterParts.push(
              `[${curV}][${pipLabel}]overlay=x=${xExpr}:y=${yExpr}:enable='between(t\\,${enableFrom}\\,${enableTo})'[${outV}]`
            )
            curV = outV
          }
          if (asset.hasAudio) {
            const delayMs = Math.max(0, Math.round(pipStart * 1000))
            const audioLabel = `pipaudio${pipCounter}`
            /**
             * **音も絵と同じ秒で終わらせる。**
             *
             * 絵は `enable` の窓を `pipEndExport` で閉じているのに、音の枝には
             * 切る処理が無かった。繋ぎをまたぐ PiP は**絵が消えたあとも繋ぎの
             * 秒数ぶん音だけが鳴り続ける**。同じ食い違いは BGM・効果音の側で
             * 一度直してあり(`toExportEndTime` の注記)、**PiP の音だけが
             * 取り残されていた**。
             * (実測: 本編5秒×2本を1.0秒の繋ぎでつなぎ、タイムライン [2.0, 6.0] に
             *  PiP を置くと、絵は 5.033秒で消えるのに音は **6.0秒**まで鳴り、
             *  **0.967秒**ずれていた。繋ぎ無しでは絵 6.033秒・音 6.0秒で一致)
             *
             * 入力は `-t pipVisibleDuration` で切ってあるが、AAC はフレーム境界
             * (約23ms)でしか切れないので、秒ちょうどに揃えるのはここで行う。
             */
            const PIP_TRIM_EPSILON = 1e-6
            const pipTrim =
              pipAudibleDur < pipVisibleDuration - PIP_TRIM_EPSILON
                ? `atrim=0:${pipAudibleDur},`
                : ''
            filterParts.push(
              `[${pipAudioIndex}:a]asetpts=PTS-STARTPTS,${pipTrim}${adelayFilter(delayMs)},` +
                `${audioFormatFor(audioChannelsByPath.get(asset.filePath))}[${audioLabel}]`
            )
            pipAudioEntries.push({ label: audioLabel, duck: false })
          }
          pipCounter++
        })
      })

      let videoLabel = `[${curV}]`
      if (includeVideo && telopListPath) {
        // 共通レンダラの層を重ねる(長尺向けの `segmentGraph` と同じ組み方)。
        // 層は「絵が替わる瞬間だけ1枚」のまばらな入力のまま重ねる。毎フレームへ複製すると
        // 全フレームぶんの RGBA が overlay の待ち行列に溜まり、メモリを使い切る
        command.input(telopListPath).inputOptions(['-f concat', '-safe 0'])
        const layerIndex = inputIndex++
        // 層は v2 のシーケンスの大きさで描いてある。普通は出力と同じだが、違えば合わせる
        const layerScale =
          telopLayer && (telopLayer.width !== w || telopLayer.height !== h)
            ? `scale=${w}:${h},`
            : ''
        filterParts.push(`[${layerIndex}:v]${layerScale}format=rgba,settb=${frameTb}[telop]`)
        // 長さは本編で決める(`shortest`)。層の一覧は本編より長めに作ってあるので、先に切れることはない
        filterParts.push(`[${curV}][telop]overlay=0:0:format=auto:eof_action=pass:shortest=1[vout]`)
        videoLabel = '[vout]'
      } else if (includeVideo && !usesTelopLayer && project.textOverlays.length > 0) {
        assDir = mkdtempSync(join(tmpdir(), 've-subs-'))
        const assPath = join(assDir, 'overlay.ass')
        // 端ごとに `toExportTime` を掛けると、繋ぎをまたぐ区間で**終わりが始まりより前**に
        // なる。ASS はそれを消せず**最後まで出しっぱなし**になるので、終わりは対で換算する
        // (理由と実測は `toExportEndTime`)。カラオケの語も同じ理由で同じ換算を通す。
        const remappedOverlays = project.textOverlays.map((o) => ({
          ...o,
          startTime: toExportTime(o.startTime),
          endTime: toExportEndTime(o.startTime, o.endTime),
          words: o.words?.map((word) => ({
            ...word,
            start: toExportTime(word.start),
            end: toExportEndTime(word.start, word.end)
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
        filterParts.push(`[${curV}]subtitles=filename=${escapeFilterPath(assPath)}[vout]`)
        videoLabel = '[vout]'
      }
      // 出力の直前で画素形式を固定する。ここが最後の砦なので、映像の枝を足しても消しても
      // 成果物の形式が変わらない(上の VIDEO_FORMAT のコメント参照)。
      if (includeVideo) {
        filterParts.push(`${videoLabel}${VIDEO_FORMAT}[vfmt]`)
        videoLabel = '[vfmt]'
      }

      // --- Extra audio tracks (BGM / narration) mixed on top of the main audio ---
      const perTrackAudio: { label: string; duck: boolean }[] = []
      /**
       * 「本編の音」のうち、**音声トラックへ移っているぶん**の枝。
       *
       * 音声分離(`audioDetached`)を使うと、本編クリップの音声の枝は `anullsrc`
       * (デジタル無音)になり、実際の声は `linkedClipId` を持つ音声クリップへ移る。
       * サイドチェインの入力を `curA` に決め打ちすると、**無音を測ることになり
       * `sidechaincompress` が一度も反応しない**(設定は ON のまま、下がり幅 0)。
       */
      const mainVoiceLabels: string[] = []
      // 枝を割るかどうかは**サイドチェインが要るときだけ**。ダッキングを使っていない
      // プロジェクトの枝は1本も変えない(割った出力を誰も受け取らないと、
      // `Error binding filtergraph inputs/outputs` で書き出しごと落ちる)。
      const duckingInUse = project.audioTracks.some((t) => t.duckingEnabled && !t.muted)
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
          const clipStartExport = toExportTime(trackClip.startTime)
          const delayMs = Math.max(0, Math.round(clipStartExport * 1000))
          // 音量の式はプレビューと同じ共通モジュール(2箇所に書くと片方だけ育つ)。
          const clipVolume = audioClipGain(track.volume, trackClip.volume)
          // 分離音声は本編クリップの速度がミラーされている。ここで atempo を掛けないと
          // 映像だけ速くなって音が置き去りになる(atempoChain が 0.5〜2.0 の定義域を連鎖で吸収)。
          const clipSpeed = trackClip.speed || 1
          // atempo のあとの尺 = タイムライン上の尺。フェードはこの時間軸で掛ける。
          // asetpts でクリップ自身は0始まりに正規化されるので、フェードの位置に
          // toExportTime は通さない(絶対位置は adelay 側が既に通している)。
          const timelineDur = dur / clipSpeed
          /**
           * **鳴り終わりも書き出しの秒へ換算する。**
           *
           * 始まり(`adelay`)だけ換算して終わりを「換算した始まり + 素材の尺」の
           * ままにすると、繋ぎをまたぐ BGM・効果音が**繋ぎの秒数ぶん長く鳴る**。
           * 同じ区間に置いた PiP とテロップは終わりも換算済みなので、
           * **同じ区間の3つが揃わない**(実測: タイムライン [2.0, 6.0] の BGM が
           * 正しい 5.0秒を過ぎて 6.0秒まで鳴り、PiP とテロップだけ 5.0秒で終わった)。
           *
           * 揃え方は**詰める(切る)**。`enable` の窓を狭める PiP と同じで、
           * 繋ぎに食われた秒数ぶん**後ろが落ちる**。自動でフェードを足すことはしない
           * ——アウト点で切ったときと同じ挙動に揃えるため、そして利用者が
           * フェードアウトを 0 にしている意図を勝手に覆さないため。
           * 代わりに、**利用者が付けたフェードアウトは詰めたあとの終わりに掛ける**
           * (詰める前の位置のままだと、フェードごと切り落とされて全音量で止まる)。
           */
          const clipEndExport = toExportEndTime(
            trackClip.startTime,
            trackClip.startTime + timelineDur
          )
          const exportDur = clipEndExport - clipStartExport
          // 引き算の誤差(1e-16 の桁)で切りにいかないための余裕。ここより短い差は
          // 音として存在しないので、繋ぎをまたがない今までの書き出しは1バイトも変わらない。
          const TRIM_EPSILON = 1e-6
          const audibleDur = exportDur < timelineDur - TRIM_EPSILON ? exportDur : timelineDur
          const trimChain = audibleDur < timelineDur ? `atrim=0:${audibleDur},` : ''
          const { fadeIn, fadeOut } = normalizeFades(
            trackClip.fadeIn,
            trackClip.fadeOut,
            audibleDur
          )
          const fadeParts: string[] = []
          if (fadeIn > 0) fadeParts.push(`afade=t=in:st=0:d=${fadeIn}`)
          if (fadeOut > 0) {
            fadeParts.push(`afade=t=out:st=${Math.max(0, audibleDur - fadeOut)}:d=${fadeOut}`)
          }
          const fadeChain = fadeParts.length > 0 ? `${fadeParts.join(',')},` : ''
          filterParts.push(
            `[${myIndex}:a]${audioSpeedChain(clipSpeed)},asetpts=PTS-STARTPTS,${trimChain}${fadeChain}` +
              `volume=${clipVolume},${adelayFilter(delayMs)},` +
              `${audioFormatFor(audioChannelsByPath.get(asset.filePath))}[${label}]`
          )
          if (
            duckingInUse &&
            !track.duckingEnabled &&
            (isMainVoiceClip(trackClip) || track.voice)
          ) {
            // 分離された本編の音。**出力へ混ぜる枝とサイドチェインへ渡す枝の2本**に割る
            // (同じラベルを2箇所へ繋ぐことはできない)。測るのは音量・フェードを
            // 通したあと——利用者が声を小さくしたら、下がり方もそのぶん弱くなるのが正しい。
            filterParts.push(`[${label}]asplit=2[${label}_mix][${label}_voice]`)
            mainVoiceLabels.push(`${label}_voice`)
            clipLabels.push(`${label}_mix`)
            return
          }
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
        // サイドチェインに渡すのは「本編の音」= 本編クリップの音声 + 分離された音声クリップ。
        // 分離が無ければ枝は今までと1本も変わらない(`mainVoiceLabels` が空)。
        if (mainVoiceLabels.length > 0) {
          filterParts.push(`[${curA}]asplit=2[${curA}_mixcopy][${curA}_voice]`)
          mainAudioForMix = `${curA}_mixcopy`
          const voiceInputs = [`[${curA}_voice]`, ...mainVoiceLabels.map((l) => `[${l}]`)].join('')
          // 尺は本編に合わせる(`duration=first`)。分離音声はその一部にしか無い。
          filterParts.push(
            `${voiceInputs}amix=inputs=${mainVoiceLabels.length + 1}:duration=first:` +
              `dropout_transition=0:normalize=0,${AUDIO_FORMAT}[mainvoice]`
          )
          filterParts.push(
            `[mainvoice]asplit=${duckTracks.length}` +
              duckTracks.map((_, i) => `[${curA}_duck${i}]`).join('')
          )
        } else {
          const splitOutputs = [
            `[${curA}_mixcopy]`,
            ...duckTracks.map((_, i) => `[${curA}_duck${i}]`)
          ]
          filterParts.push(`[${curA}]asplit=${duckTracks.length + 1}${splitOutputs.join('')}`)
          mainAudioForMix = `${curA}_mixcopy`
        }
        // 下げる音と、本編の音(サイドチェイン)を、どちらも本編の長さちょうどに揃えてから掛ける。
        // 揃えないと、片方が先に尽きたところで、読み込み済みの音を捨てることがある(ffmpeg の
        // 読み込みの順で毎回変わる。実測: 0〜4秒の BGM が 6 回中 4 回、0.7〜0.9 秒短く切れた)
        // `sidechaincompress` は、どちらかの入力が尽きた所で、まだ処理していない音を捨てて終わる。
        // 長さを揃えても、どちらが先に尽きるかは読み込みの順で変わる。両方を無音で終わりなく延ばし、
        // 掛けた後で本編の長さに切る(どちらも尽きないので、捨てられる音が無い)
        duckTracks.forEach((t, i) => {
          const duckedLabel = `${t.label}_ducked`
          filterParts.push(`[${t.label}]apad[${t.label}_fit]`)
          filterParts.push(`[${curA}_duck${i}]apad[${curA}_duck${i}_fit]`)
          filterParts.push(
            `[${t.label}_fit][${curA}_duck${i}_fit]${duckingFilterArgs()},` +
              `atrim=end=${ffSeconds(totalDuration)}[${duckedLabel}]`
          )
          t.label = duckedLabel
        })
      } else {
        // 「ダッキングを使っている」と見て枝を割ったのに、下げる相手が1本も残らなかった
        // (そのトラックにクリップが無い・素材が見つからない)。**割った出力は必ず誰かが
        // 受け取らなければならない**ので、ここで捨てる。
        mainVoiceLabels.forEach((label) => filterParts.push(`[${label}]anullsink`))
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

      return { filterParts, videoLabel, audioLabel, assDir }
    }
  }

  // --- ラウドネス正規化の測定パス(2パスの1回目) ---
  //
  // loudnorm を1パス(dynamic)で使うと、素材が平坦なら正確だが、音量差(LRA)の大きい
  // 素材ほど目標の -14 LUFS から遠ざかり、音の幅も潰れる(実測: LRA 18.5 の素材で
  // -14.66 LUFS・LRA 14.5 に圧縮。ズレは LRA に比例して広がる)。
  // 書き出しと同じ音声グラフを `-f null` で流して measured_* を測り、本番は
  // linear(一定ゲイン)で掛ける。測定に失敗したとき(解析不能・全編無音の -inf など)は
  // 従来の1パスへ落とす——正規化の精度のために書き出し自体を失敗させない。
  let measured: LoudnessMeasurement | null = null
  if (loudnessNormalization) {
    measured = await new Promise<LoudnessMeasurement | null>((resolveMeasure) => {
      let graphDir: string | null = null
      const cleanup = (): void => {
        if (graphDir) rmSync(graphDir, { recursive: true, force: true })
      }
      try {
        const command = ffmpeg()
        const built = buildGraph(command, false)
        built.filterParts.push(
          `${built.audioLabel}${loudnormMeasureFilter(options.loudnessTarget)}[aloud]`
        )
        graphDir = mkdtempSync(join(tmpdir(), 've-graph-'))
        const graphPath = join(graphDir, 'filtergraph.txt')
        writeFileSync(graphPath, built.filterParts.join(';'), 'utf-8')
        // loudnorm の測定結果は stderr の末尾に JSON で出る。全行貯めると長尺で
        // 際限なく膨らむので、後ろだけ持つ
        const stderrTail: string[] = []
        command
          .outputOptions('-filter_complex_script', graphPath)
          .outputOptions(['-map [aloud]', '-f null'])
          .output(process.platform === 'win32' ? 'NUL' : '/dev/null')
          .on('start', () => onProgress(0, '音量を測定中'))
          .on('progress', (progress) => {
            const seconds = timemarkToSeconds(progress.timemark)
            const percent = totalDuration > 0 ? Math.min(29, (seconds / totalDuration) * 30) : 0
            onProgress(percent, '音量を測定中')
          })
          .on('stderr', (line: string) => {
            stderrTail.push(line)
            if (stderrTail.length > 200) stderrTail.shift()
          })
          .on('error', () => {
            cleanup()
            resolveMeasure(null)
          })
          .on('end', () => {
            cleanup()
            resolveMeasure(parseLoudnormMeasurement(stderrTail.join('\n')))
          })
          .run()
        currentExportCommand = command
        trackExportCommand(command)
        // グラフ組み立て中にキャンセルが来ていたら、ハンドルが出来たいま倒す
        if (exportCancelRequested) command.kill('SIGKILL')
      } catch {
        cleanup()
        resolveMeasure(null)
      }
    })
    currentExportCommand = null
    if (exportCancelRequested) {
      exportInProgress = false
      throw new Error('EXPORT_CANCELED')
    }
  }
  // エンコードの進み表示。測定パスが走ったときは 30% から先を使う
  const progressBase = measured ? 30 : 0

  return new Promise((resolve, reject) => {
    let command: ffmpeg.FfmpegCommand
    let assDir: string | null = null
    /** フィルタグラフを書いたファイルの置き場(理由は `-filter_complex_script` を渡す箇所) */
    let graphDir: string | null = null
    /** テロップの層の画像と concat 一覧の置き場 */
    let telopDir: string | null = null
    const cleanupTempDirs = (): void => {
      if (assDir) rmSync(assDir, { recursive: true, force: true })
      if (graphDir) rmSync(graphDir, { recursive: true, force: true })
      if (telopDir) rmSync(telopDir, { recursive: true, force: true })
    }
    try {
      command = ffmpeg()
      let telopListPath: string | null = null
      if (telopLayer) {
        telopDir = mkdtempSync(join(tmpdir(), 've-telop-'))
        const dir = telopDir
        // 画像は描きながら main の置き場へ書いてある(`stagedId`)。バイト列で来たときだけここへ書く
        const imagePaths = materializeTelopLayer(telopLayer, () => dir)?.imagePaths ?? []
        // 層の区間は v2 のフレーム(`projectV1ToV2`)。v2 は書き出しと同じ `createExportTimeMap` と
        // 同じフレームレートで数えるので、頭からフレームで並べればそのまま時刻が合う。
        // 一覧は本編より1秒長く(後ろは透明)作り、長さは overlay の `shortest` で本編に揃える。
        // 本編ちょうどにすると、concat の決まりで最後に足す1枚のぶん**映像が1フレーム伸びる**
        // (実測: 30フレームの本編が31フレームになった)。丸めで本編が長くても層が先に尽きない
        const totalFrames =
          Math.round(mainLayout.totalExportDuration * outputFps) + Math.ceil(outputFps)
        const list = telopConcatList(telopLayer.runs, imagePaths, 0, totalFrames, outputRate)
        if (list) {
          telopListPath = join(dir, 'telop.ffconcat')
          writeFileSync(telopListPath, list, 'utf-8')
        }
      }
      const built = buildGraph(command, true, telopListPath)
      const filterParts = built.filterParts
      const videoLabel = built.videoLabel
      let audioLabel = built.audioLabel
      assDir = built.assDir

      if (loudnessNormalization) {
        // loudnorm は内部を 192kHz で回すため、後ろを固定しないと**出力が 96kHz になる**
        // (実測: 48kHz の素材が 96kHz で書き出されていた)。既定でONなので既定のまま
        // 書き出すと必ず踏む。ここでも形式を戻す。
        // 測定パスが成功していれば measured_* を渡して linear で掛ける。dynamic と
        // 違って -14 LUFS へ狙いどおり寄り、音の幅(LRA)も潰れない。
        // LRA の指定は linear では「これを超えたら dynamic へ落とす」閾値でしかなく、
        // 増幅量には効かない。素材の LRA が 11 を超えていると黙って dynamic に
        // 戻ってしまう(実測: LRA 18.5 の素材で 2パス目も -14.57/LRA 14.4 のまま)ので、
        // 測った LRA を下回らない値を渡して linear を守る(上限 50 は loudnorm の定義域)
        const loudnormArgs = loudnormApplyFilter(options.loudnessTarget, measured)
        filterParts.push(`${audioLabel}${loudnormArgs},${AUDIO_FORMAT}[aloud]`)
        audioLabel = '[aloud]'
      }

      // **フィルタグラフはコマンドラインに載せず、ファイルで渡す。**
      //
      // `complexFilter()` はグラフ全体を `-filter_complex <巨大な1引数>` として渡すが、
      // OS には**引数1つあたりの上限**がある。Linux は `MAX_ARG_STRLEN` = 32ページ
      // = **131,072 バイト**、Windows はコマンドライン全体で **32,767 文字**。
      // グラフはクリップ1本あたり約 590 文字増えるので、上限は本数で決まる
      // (実測: 40本で 28,448 / 50本で 35,518 / 215本で 128,592 文字)。
      //
      // 超えると `child_process.spawn` が **同期的に `E2BIG` を投げる**。これは
      // fluent-ffmpeg の `.on('error')` には渡らず、非同期コールバックの中から
      // 投げられるので `ipcMain.handle` にも捕まらない——**main プロセスごと落ちる**
      // (実測: 215本は成功、**220本でアプリが異常終了**。書き出し先には何も残らない)。
      // 無音カット・フィラーカット・ジャンプカット・AIおまかせはどれも断片を
      // 数十〜数百本作るので、**この本数は普通に届く**。
      //
      // `-filter_complex_script` は非推奨の警告が出るが、`-/filter_complex`(ffmpeg 7.0〜)
      // と違って**古い ffmpeg でも通る**。`ffmpeg-static` は `^5.3.0` で入る実体の版が
      // 動きうるので、通る範囲の広いほうを選ぶ。
      graphDir = mkdtempSync(join(tmpdir(), 've-graph-'))
      const graphPath = join(graphDir, 'filtergraph.txt')
      // `complexFilter()` が作るのと同じ文字列(`;` 区切り)をそのまま書く。
      writeFileSync(graphPath, filterParts.join(';'), 'utf-8')
      command
        // **引数を2つに分けて渡す。** 配列で渡すと fluent-ffmpeg が空白で切るので、
        // 一時ディレクトリの途中に空白が入る環境(Windows のユーザー名など)で壊れる。
        .outputOptions('-filter_complex_script', graphPath)
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
          const percent =
            totalDuration > 0
              ? Math.min(99, progressBase + (seconds / totalDuration) * (100 - progressBase))
              : progressBase
          onProgress(percent, 'エンコード中')
        })
        .on('error', (err, _stdout, stderr) => {
          cleanupTempDirs()
          currentExportCommand = null
          exportInProgress = false
          if (exportCancelRequested) {
            // 目印なのでそのまま(画面側が文字列で見分けている)
            rmSync(outputPath, { force: true })
            reject(new Error('EXPORT_CANCELED'))
          } else {
            reject(describeFfmpegError(err, stderr))
          }
        })
        .on('end', () => {
          cleanupTempDirs()
          currentExportCommand = null
          exportInProgress = false
          onProgress(100, '完了')
          resolve()
        })
        .run()
      currentExportCommand = command
      trackExportCommand(command)
      // A cancel that arrived while the filter graph was still being built has no
      // command to kill yet, so honour it as soon as the handle exists.
      if (exportCancelRequested) command.kill('SIGKILL')
    } catch (e) {
      cleanupTempDirs()
      currentExportCommand = null
      exportInProgress = false
      reject(e)
    }
  })
}

/** loudnorm 測定パスの結果(2パス目へ渡す measured_* 一式) */
export interface LoudnessMeasurement {
  inputI: number
  inputTP: number
  inputLRA: number
  inputThresh: number
  targetOffset: number
}

/**
 * loudnorm(print_format=json)が stderr に出す測定 JSON を読む。
 *
 * 値は `"input_i" : "-22.01"` のように**文字列**で入っており、全編無音だと
 * `"-inf"` が来る。`Number("-inf")` は NaN なので、1つでも数値にならなければ
 * 測定失敗として null を返す(呼び出し側は従来の1パスへ落とす)。
 */
export function parseLoudnormMeasurement(stderr: string): LoudnessMeasurement | null {
  const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g)
  if (!blocks || blocks.length === 0) return null
  try {
    const obj = JSON.parse(blocks[blocks.length - 1]) as Record<string, unknown>
    const m: LoudnessMeasurement = {
      inputI: Number(obj.input_i),
      inputTP: Number(obj.input_tp),
      inputLRA: Number(obj.input_lra),
      inputThresh: Number(obj.input_thresh),
      targetOffset: Number(obj.target_offset)
    }
    return Object.values(m).every(Number.isFinite) ? m : null
  } catch {
    return null
  }
}

function timemarkToSeconds(timemark: string): number {
  const parts = timemark.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return Number(timemark) || 0
}

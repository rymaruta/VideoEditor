import { stopNow, trackProcess } from './liveProcesses'
import {
  OUTPUT_AUDIO_CODEC_ARGS,
  fitEncodedLoudness,
  loudnormMeasureFilter,
  type LoudnessTarget
} from '@shared/loudness'
import { spawn } from 'child_process'
import { app } from 'electron'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync
} from 'fs'
import { rm, stat } from 'fs/promises'
import { cpus, tmpdir } from 'os'
import nodePath, { dirname, join } from 'path'
import {
  LOW_DISK_RESERVE_BYTES,
  chooseWorkLocation,
  diskRanLowMessage,
  estimateSegmentedExportBytes
} from '@shared/exportDiskSpace'
import { measureEncodedLoudness } from './encodedLoudness'
import type { ExportFormat, MediaAsset, QualityPreset, TextOverlay } from '@shared/types'
import type { ProjectV2, Sequence } from '@shared/sequence/types'
import {
  defaultSegmentOptions,
  planSegments,
  segmentsInRange,
  snapExportRange,
  type Segment,
  type SegmentPlanOptions
} from '@shared/sequence/segmentPlan'
import { textCanvasSize } from '@shared/resolution'
import type { TelopLayerPayload } from '@shared/telop/layer'
import { buildAssContent } from './assSubtitle'
import { materializeTelopLayer, TELOP_STAGE_PREFIX } from './telopLayerStage'
import { describeFfmpegExit } from './ffmpegError'
import {
  AUDIO_FORMAT,
  OUTPUT_SAMPLE_RATE,
  RESAMPLE_SPEED_LIMIT,
  ALIGN_AUDIO_START,
  assertReadableStills,
  probeAlphaDecoders,
  audioSpeedChain,
  crfForQuality,
  ffmpegPath,
  ffSeconds,
  loudnormMeasuredSilence,
  parseLoudnormMeasurement,
  probeAudioChannels,
  sourceVideoFilters,
  type LoudnessMeasurement
} from './ffmpegService'
import { measureWideAdvances } from './fontMetrics'
import { assertOutputFolderExists } from './exportOutputGuard'
import { clipsBeyondSourceMessage, sequenceItemsBeyondSource } from '@shared/clipSourceRange'
import { NO_SOURCE_METADATA_ARGS, SDR_COLOR_TAG_ARGS } from '@shared/sourceVideo'

/** 速さを変えた音を、アイテムの終わりより先に読む長さ(秒) */
const STRETCH_TAIL_SEC = 0.5
import {
  buildSegmentAudioGraph,
  buildSegmentVideoGraph,
  fpsExpr,
  frameToSeconds,
  type GraphContext,
  type SegmentGraph
} from './segmentGraph'

/**
 * セグメント分割・並列の書き出しエンジン(データモデル v2 用)。
 * 計画書: `docs/VARIETY_AUTO_EDIT_PLAN.md` §4.3
 *
 * 1. シーケンスを 20〜90秒の区間に分ける(`planSegments`)
 * 2. 区間ごとに映像(最終の形式で直接エンコード)と音声(浮動小数のまま可逆に縮めた WavPack)を
 *    **並列に**書き出す
 * 3. 映像は concat demuxer で**再エンコードせずに**繋ぎ、音声は区間の WavPack を concat demuxer で
 *    直接読んで(必要ならラウドネスを測って)AAC にし、1つの mp4 にまとめる
 *
 * 一時ファイル: 前は区間の音を無圧縮の 32bit WAV にし、さらに全体を1本の full.wav に写していたので、
 * 音だけで 1 秒 768KB(95 分で一時フォルダが 4.2GB、3時間で 8GB 超。full.wav は 4GiB を越えると
 * WAV の大きさの欄があふれる)。いまは全体の1本を作らず、区間の音は WavPack(実測で無圧縮の 4〜7 割)。
 * 書き出す前に空きを見積もり、途中でも空きが減りすぎたら止める(`LOW_DISK_RESERVE_BYTES`)
 *
 * 区間ごとの映像は**同じエンコーダ・同じ設定**で作る(途中で別のエンコーダに切り替えると、
 * 再エンコードなしの連結で壊れたファイルになる)。音声は絶対位置のサンプル数で区切るので、
 * 区間をいくつに割っても合計は全体と1サンプルも違わない(`frameToSample`)。
 */

export type VideoEncoder = 'libx264' | 'h264_nvenc'

export interface SegmentedExportOptions {
  project: ProjectV2
  outputPath: string
  quality: QualityPreset
  loudnessNormalization?: boolean
  /** 音量の基準。既定は配信(-14 LUFS) */
  loudnessTarget?: LoudnessTarget
  onProgress?: (percent: number, stage: string) => void
  /** 既定は自動(NVENC が使えれば NVENC) */
  encoder?: VideoEncoder | 'auto'
  /** 同時に走らせる ffmpeg の数。既定はエンコーダと CPU 数から決める */
  maxParallel?: number
  /**
   * 画面のプロセスが共通テロップレンダラで描いたテロップの層。あればこちらで焼き、
   * 省略時は従来の ASS で焼く(`null` は「出すテロップが無い」で、何も焼かない)
   */
  telopLayer?: TelopLayerPayload | null
  /** 区間の長さ。既定は `defaultSegmentOptions` */
  segmentOptions?: SegmentPlanOptions
  signal?: AbortSignal
  /** 一時フォルダを作る場所。既定は OS の一時フォルダ(足りなければ書き出し先のフォルダ) */
  tempDir?: string
  /** ディスクの空き(バイト)を返す。試験で差し替える。既定は `statfs` */
  diskFree?: (path: string) => number
  /** 書き出す形式。既定は MP4(H.264 + AAC) */
  format?: ExportFormat
  /** 書き出す範囲(シーケンスのフレーム)。省略は全体。境は繋ぎを割らない位置へ広げる */
  range?: { startFrame: number; endFrame: number }
}

export interface SegmentedExportResult {
  segments: number
  encoder: VideoEncoder
  parallel: number
  /** 書き出した映像のフレーム数(シーケンスの尺と一致する。範囲のときは範囲の長さ) */
  frames: number
  /**
   * 範囲のとき、実際に書き出した範囲の始まり(シーケンスのフレーム)。境が繋ぎに掛かると頼んだ所より前へ
   * 広げるので、書き出したファイルの 0 秒はここに当たる(点検の時刻はこれで合わせる)。全体なら 0
   */
  startFrame: number
}

// ------------------------------------------------------------------ ffmpeg の起動

interface RunResult {
  stderr: string
}

/** ffmpeg を1回走らせる。標準エラー出力は末尾だけ残す(長尺で膨らませない) */
function runFfmpeg(args: string[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('EXPORT_CANCELED'))
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], {
      windowsHide: true
    })
    // アプリを閉じたら止める(止めないと macOS・Linux では区間の ffmpeg が動き続け、一時フォルダも残る)
    const untrack = trackProcess(child)
    const tail: string[] = []
    let pending = ''
    child.stderr.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf-8')
      const lines = pending.split(/\r?\n|\r/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        tail.push(line)
        if (tail.length > 300) tail.shift()
      }
    })
    const onAbort = (): void => {
      stopNow(child)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => {
      untrack()
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      untrack()
      signal?.removeEventListener('abort', onAbort)
      if (pending) tail.push(pending)
      const stderr = tail.join('\n')
      if (signal?.aborted) return reject(new Error('EXPORT_CANCELED'))
      if (code === 0) resolve({ stderr })
      else reject(describeFfmpegExit(code, stderr))
    })
  })
}

/**
 * 入力1つあたりのデコーダのスレッド数。**1 にする。**
 * 区間には素材を十数本〜数十本まとめて入れるので、既定(コア数+1)のままだと入力ごとに
 * フレームのバッファを抱え、本数 × コア数でメモリが膨らむ。並列は区間の単位で取るので、
 * 1本の中で細かく割らなくても遅くならない
 * (実測: 0.75秒×400カット・5分・720p・2並列で、既定は ffmpeg 合計 7.1GB/63秒、
 *  2 で 5.5GB/58秒、**1 で 4.8GB/55秒**)
 */
const DECODER_THREADS = 1

/** 透過付きの素材の入力に、透過を読めるデコーダを付ける */
function withDecoders(graph: SegmentGraph, decoders: ReadonlyMap<string, string>): SegmentGraph {
  if (decoders.size === 0) return graph
  return {
    ...graph,
    inputs: graph.inputs.map((input) =>
      !input.still && input.concatList === undefined && decoders.has(input.path)
        ? { ...input, decoder: decoders.get(input.path) }
        : input
    )
  }
}

/** 入力ごとの `-ss / -t / -i` と、グラフをファイルで渡す引数 */
function graphArgs(graph: SegmentGraph, graphPath: string): string[] {
  writeFileSync(graphPath, graph.filter, 'utf-8')
  const args: string[] = []
  graph.inputs.forEach((input, i) => {
    if (input.concatList !== undefined) {
      const listPath = `${graphPath}.in${i}.ffconcat`
      writeFileSync(listPath, input.concatList, 'utf-8')
      args.push('-f', 'concat', '-safe', '0', '-i', listPath)
      return
    }
    args.push('-threads', String(DECODER_THREADS))
    if (input.still) {
      // 静止画は同じ画を必要な秒数ぶん流す(シークは意味が無い)
      args.push(
        '-loop',
        '1',
        ...(input.framerate ? ['-framerate', input.framerate] : []),
        '-t',
        String(Math.max(0.001, input.duration)),
        '-i',
        input.path
      )
      return
    }
    if (input.decoder) args.push('-c:v', input.decoder)
    // 丸めの残り(5.55e-17)を指数で書くと ffmpeg が読めないので、小数6桁で書く
    args.push('-ss', ffSeconds(input.seek), '-t', ffSeconds(Math.max(0.001, input.duration)))
    args.push('-i', input.path)
  })
  // 理由は v1 の書き出しと同じ(コマンドラインの長さの上限・空白を含むパス)
  args.push('-filter_complex_script', graphPath, '-map', graph.outLabel)
  return args
}

// ------------------------------------------------------------------ エンコーダ

let encoderProbe: Promise<VideoEncoder> | null = null

/** 環境変数 VE_VIDEO_ENCODER の値(libx264 だけ受ける。ほかの値・未設定は自動) */
export function forcedVideoEncoder(value: string | undefined): VideoEncoder | null {
  return value?.trim().toLowerCase() === 'libx264' ? 'libx264' : null
}

/**
 * NVENC が**実際に**使えるかを、小さな絵を1回エンコードして確かめる。
 * `-encoders` の一覧に載っていても、ドライバが古い・GPU が無い環境では開けない。
 * 結果はプロセスの間だけ覚える。
 */
export function detectVideoEncoder(): Promise<VideoEncoder> {
  // 確かめ用: VE_VIDEO_ENCODER=libx264 で CPU に固定する(GPU と CPU の書き出しの比べ。docs/GPU_TEST.md)
  if (forcedVideoEncoder(process.env.VE_VIDEO_ENCODER) === 'libx264')
    return Promise.resolve('libx264')
  if (!encoderProbe) {
    encoderProbe = runFfmpeg([
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=256x144:r=30:d=0.2',
      '-c:v',
      'h264_nvenc',
      '-f',
      'null',
      '-'
    ]).then(
      (): VideoEncoder => 'h264_nvenc',
      (): VideoEncoder => 'libx264'
    )
  }
  return encoderProbe
}

/** エンコードの引数。**全区間で同じ**であること(連結の前提) */
export function videoEncodeArgs(
  encoder: VideoEncoder,
  quality: QualityPreset,
  fps: string
): string[] {
  const q = crfForQuality(quality)
  const common = ['-pix_fmt', 'yuv420p', '-r', fps, '-video_track_timescale', '90000']
  if (encoder === 'h264_nvenc') {
    return [
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p5',
      '-rc',
      'vbr',
      '-cq',
      String(q),
      '-b:v',
      '0',
      ...common
    ]
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q), ...common]
}

/**
 * 保存用の高画質(Apple ProRes 422・10bit 4:2:2)のエンコードの引数。**全区間で同じ**であること。
 * `prores_ks` は CPU で動く(GPU のエンコーダは無い)。入れ物は QuickTime(.mov)
 */
export function proresEncodeArgs(fps: string): string[] {
  return [
    '-c:v',
    'prores_ks',
    '-profile:v',
    '2',
    '-vendor',
    'apl0',
    '-pix_fmt',
    'yuv422p10le',
    '-r',
    fps,
    '-video_track_timescale',
    '90000'
  ]
}

/** 書き出しの最後に音を書く引数(形式ごと)。MP4 は AAC、ProRes の .mov と WAV は PCM 24bit */
export function finalAudioCodecArgs(format: ExportFormat): string[] {
  return format === 'mp4' ? OUTPUT_AUDIO_CODEC_ARGS : ['-c:a', 'pcm_s24le']
}

/**
 * 区間の映像(再エンコードなしで連結)と区間の音をまとめる最後の ffmpeg の引数。
 * 音声だけ(WAV)は映像を読まない。WAV は 4GiB を越えると大きさの欄があふれるので RF64 を許す
 */
export function finalMuxArgs(
  format: ExportFormat,
  videoList: string,
  audioInput: readonly string[],
  audioFilter: readonly string[],
  outputPath: string
): string[] {
  if (format === 'wav')
    return [
      '-v',
      'error',
      ...audioInput,
      '-map',
      '0:a',
      ...audioFilter,
      ...finalAudioCodecArgs(format),
      '-ar',
      String(OUTPUT_SAMPLE_RATE),
      '-rf64',
      'auto',
      ...NO_SOURCE_METADATA_ARGS,
      outputPath
    ]
  return [
    '-v',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    videoList,
    ...audioInput,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'copy',
    ...audioFilter,
    ...finalAudioCodecArgs(format),
    '-movflags',
    '+faststart',
    ...NO_SOURCE_METADATA_ARGS,
    outputPath
  ]
}

/**
 * 同時に走らせる数。
 * - NVENC: GeForce は同時セッション数に上限がある(世代・ドライバで変わる)ため控えめに 4。
 * - libx264: 1本で複数コアを使うので、コア数の 1/4(最大6)。
 */
export function defaultParallelism(encoder: VideoEncoder, cpuCount = cpus().length): number {
  if (encoder === 'h264_nvenc') return 4
  return Math.max(1, Math.min(6, Math.floor(cpuCount / 4)))
}

/** 進捗に出すエンコーダの名前。GPU で書き出せているかを利用者が確かめられるように */
export function encoderLabel(encoder: VideoEncoder): string {
  return encoder === 'h264_nvenc' ? 'GPU: NVENC' : 'CPU: x264'
}

// ------------------------------------------------------------------ テロップ

/** v2 のテロップを、ASS の生成器(v1 の形)へ渡せる形にする。時刻はシーケンスの絶対秒 */
export function telopsAsOverlays(seq: Sequence): TextOverlay[] {
  const out: TextOverlay[] = []
  for (const track of seq.videoTracks) {
    if (track.hidden) continue
    for (const item of track.items) {
      if (item.kind !== 'telop') continue
      const start = frameToSeconds(seq, item.startFrame)
      out.push({
        id: item.id,
        text: item.text,
        startTime: start,
        endTime: frameToSeconds(seq, item.startFrame + item.durationFrames),
        style: item.style,
        ...(item.words
          ? { words: item.words.map((w) => ({ ...w, start: start + w.start, end: start + w.end })) }
          : {})
      })
    }
  }
  return out
}

// ------------------------------------------------------------------ 本体

/** 並列数を上限に、仕事を順に流す。1つでも失敗したら残りを止めて失敗を返す */
async function runPool<T>(jobs: (() => Promise<T>)[], parallel: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length)
  let next = 0
  let failed: unknown = null
  const worker = async (): Promise<void> => {
    while (failed === null && next < jobs.length) {
      const i = next++
      try {
        results[i] = await jobs[i]()
      } catch (e) {
        if (failed === null) failed = e
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker))
  if (failed !== null) throw failed
  return results
}

/** 一時的な失敗(NVENC のセッション枠が空いていない等)に備え、区間の書き出しは1回だけやり直す */
async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (signal?.aborted) throw e
    return fn()
  }
}

export async function exportSequenceSegmented(
  options: SegmentedExportOptions
): Promise<SegmentedExportResult> {
  const { project, outputPath, quality, signal } = options
  const format: ExportFormat = options.format ?? 'mp4'
  const withVideo = format !== 'wav'
  const onProgress = options.onProgress ?? ((): void => {})
  const seq = project.sequence
  const fps = fpsExpr(seq)
  const planned = planSegments(
    seq,
    options.segmentOptions ?? defaultSegmentOptions(seq.fps.num / seq.fps.den)
  )
  // 範囲だけを書き出すときは、全体の区間の並びから範囲に掛かる所を切り出す(区間の作り方は全体と同じ)
  const snapped = options.range
    ? snapExportRange(seq, options.range.startFrame, options.range.endFrame)
    : null
  if (options.range && !snapped)
    throw new Error('書き出す範囲に、タイムラインのクリップがありません')
  const segments = snapped
    ? segmentsInRange(planned, snapped.startFrame, snapped.endFrame)
    : planned
  if (segments.length === 0) throw new Error('タイムラインにクリップがありません')
  assertReadableStills(
    project.assets,
    seq.videoTracks
      .filter((t) => !t.hidden)
      .flatMap((t) => t.items.map((i) => ('assetId' in i ? i.assetId : '')))
  )
  // 入点が素材の長さより後ろのクリップ・書き出し先のフォルダが無いときは、始める前に
  // 原因の分かる文面で止める(理由は `clipsBeyondSource`・`assertOutputFolderExists`)
  const beyondSource = clipsBeyondSourceMessage(sequenceItemsBeyondSource(project))
  if (beyondSource) throw new Error(beyondSource)
  assertOutputFolderExists(outputPath)
  /** 書き出すフレームの数(範囲のときは範囲の長さ) */
  const totalFrames = segments.reduce((n, s) => n + (s.endFrame - s.startFrame), 0)

  // ProRes と音声だけは H.264 のエンコーダを使わない(GPU を調べない。並列の数は CPU の数で決める)
  const encoder: VideoEncoder =
    format !== 'mp4'
      ? 'libx264'
      : options.encoder && options.encoder !== 'auto'
        ? options.encoder
        : await detectVideoEncoder()
  const parallel = Math.max(1, options.maxParallel ?? defaultParallelism(encoder))
  const encoderText =
    format === 'prores' ? 'CPU: ProRes 422' : format === 'wav' ? '音声のみ' : encoderLabel(encoder)

  const diskFree = options.diskFree ?? freeBytes
  const work = makeWorkDir(
    options.tempDir ?? tmpdir(),
    outputPath,
    estimateSegmentedExportBytes({
      durationSec: frameToSeconds(seq, totalFrames),
      width: seq.width,
      height: seq.height,
      fps: seq.fps.num / seq.fps.den,
      quality,
      stretchedSec: stretchedSeconds(seq),
      format
    }),
    diskFree
  )
  // 途中でディスクの空きが減りすぎたら止める(区間の映像は絵柄で見込みの数倍になりうる)
  const lowDisk = new AbortController()
  let lowDiskError: Error | null = null
  // 一時フォルダと書き出し先が別のドライブなら、両方を見る
  const watchPaths = sameVolume(work, dirname(outputPath)) ? [work] : [work, dirname(outputPath)]
  const checkDisk = (): void => {
    if (lowDiskError) return
    const frees = watchPaths.map((p) => safeFree(diskFree, p)).filter((v) => v !== null)
    const free = frees.length > 0 ? Math.min(...frees) : null
    if (free !== null && free < LOW_DISK_RESERVE_BYTES) {
      lowDiskError = new Error(diskRanLowMessage(free))
      lowDisk.abort()
    }
  }
  const watch = setInterval(checkDisk, 1000)
  watch.unref?.()
  const outerSignal = signal
  const runSignal = outerSignal ? AbortSignal.any([outerSignal, lowDisk.signal]) : lowDisk.signal
  try {
    const assetsById = new Map(project.assets.map((a) => [a.id, a]))

    // 音声のチャンネル数(モノラル・5.1ch の扱いが v1 と揃うように)
    const audioPaths = new Set<string>()
    for (const t of seq.audioTracks) {
      for (const i of t.items) {
        const a = assetsById.get(i.assetId)
        if (a?.hasAudio) audioPaths.add(a.filePath)
      }
    }
    const audioChannels = new Map<string, number>()
    await Promise.all(
      [...audioPaths].map(async (p) => {
        const ch = await probeAudioChannels(p)
        if (ch !== undefined) audioChannels.set(p, ch)
      })
    )

    // ワイプ・全面(CG)の透過付き WebM は、透過を読めるデコーダで読む(1本目の映像トラックは本編)
    const alphaDecoders = await probeAlphaDecoders(
      seq.videoTracks
        .slice(1)
        .filter((t) => !t.hidden)
        .flatMap((t) => t.items)
        .map((i) => ('assetId' in i ? assetsById.get(i.assetId) : undefined))
        .filter((a): a is MediaAsset => !!a && a.hasVideo && !a.still)
        .map((a) => a.filePath)
    )

    // インターレースの解除・HDR のトーンマッピングが要る素材(SDR・プログレッシブは入れない)
    const sourceVideo = await sourceVideoFilters(
      seq.videoTracks
        .filter((t) => !t.hidden)
        .flatMap((t) => t.items)
        .map((i) => ('assetId' in i ? assetsById.get(i.assetId) : undefined))
        .filter((a): a is MediaAsset => !!a && a.hasVideo && !a.still)
        .map((a) => a.filePath),
      // HDR の素材は出力の大きさまで縮めてからトーンマッピングする(4K のまま掛けると重い)
      { w: seq.width, h: seq.height }
    )

    // テロップ: 画面のプロセスが描いた層があればそれを使う(画面と同じ絵になる)。
    // 無ければシーケンス全体で1つの ASS にし、各区間は時刻をずらして使う
    let assPath: string | undefined
    let telopLayer: GraphContext['telopLayer']
    // 画像は描きながら main の置き場へ書いてある(`stagedId`)。バイト列で来たときだけここへ書く
    // 音声だけの書き出しには絵が無いので、テロップは描かない
    const layer =
      withVideo && options.telopLayer ? materializeTelopLayer(options.telopLayer, () => work) : null
    if (layer) {
      if (layer.width !== seq.width || layer.height !== seq.height) {
        throw new Error('テロップの画像の大きさが書き出しの解像度と合いません')
      }
      telopLayer = { runs: layer.runs, imagePaths: layer.imagePaths }
    }
    // `null` は「画面のプロセスが描いた結果、出すテロップが無かった」。ASS で描き直さない
    const overlays =
      !withVideo || telopLayer || options.telopLayer === null ? [] : telopsAsOverlays(seq)
    if (overlays.length > 0) {
      const wideEmByFont = await measureWideAdvances(ffmpegPath, overlays)
      const canvas = textCanvasSize(seq.width >= seq.height ? '16:9' : '9:16')
      assPath = join(work, 'telop.ass')
      writeFileSync(assPath, buildAssContent(overlays, canvas.w, canvas.h, wideEmByFont), 'utf-8')
    }

    // 速さを変えた音(atempo で伸び縮みさせるもの)は、先に1回だけ伸び縮みさせて WAV に書く。
    // 区間ごとに atempo を掛けると、区間の境目で波形がつながらず「プツッ」と鳴る(atempo の出力は
    // 読み始めの位置で変わる)。区間ごとに頭から読み直すと、長いクリップで読む量が長さの2乗で増える
    const stretched = new Map<string, string>()
    for (const t of seq.audioTracks) {
      if (t.muted) continue
      for (const item of t.items) {
        const speed = item.speed > 0 ? item.speed : 1
        if (Math.abs(speed - 1) <= RESAMPLE_SPEED_LIMIT) continue
        const asset = assetsById.get(item.assetId)
        if (!asset?.hasAudio) continue
        // 区間の終わりの少し先まで(atempo は入力の終わりで出し方が変わる)
        const want = (frameToSeconds(seq, item.durationFrames) + STRETCH_TAIL_SEC) * speed
        const read =
          item.sourceOut !== undefined && item.sourceOut > item.sourceIn
            ? Math.min(want, item.sourceOut - item.sourceIn)
            : want
        // WAV のまま(区間ごとに -ss で読むので、読み始めの位置が確実な形式。空の WavPack は開けない)。
        // 長いクリップでも 4GiB で大きさの欄があふれないよう、越えるときは RF64 にする
        const out = join(work, `stretch_${stretched.size}.wav`)
        await runFfmpeg(
          [
            '-v',
            'error',
            '-ss',
            ffSeconds(item.sourceIn),
            '-t',
            ffSeconds(read),
            '-i',
            asset.filePath,
            '-vn',
            '-af',
            `${ALIGN_AUDIO_START},${audioSpeedChain(speed)}`,
            '-c:a',
            'pcm_f32le',
            '-rf64',
            'auto',
            '-ar',
            String(OUTPUT_SAMPLE_RATE),
            ...NO_SOURCE_METADATA_ARGS,
            out
          ],
          runSignal
        )
        stretched.set(item.id, out)
        const ch = audioChannels.get(asset.filePath)
        if (ch !== undefined) audioChannels.set(out, ch)
      }
    }

    const ctx: GraphContext = {
      sequence: seq,
      assetsById,
      audioChannels,
      assPath,
      telopLayer,
      stretched,
      sourceFilters: sourceVideo.filters
    }
    // HDR を BT.709 へ寄せたときは、出力にもそう書く(全区間で同じ引数。SDR だけの書き出しは今までどおり)
    const encodeArgs = [
      ...(format === 'prores' ? proresEncodeArgs(fps) : videoEncodeArgs(encoder, quality, fps)),
      ...(sourceVideo.hasHdr ? SDR_COLOR_TAG_ARGS : [])
    ]
    const threadsPerJob =
      encoder === 'libx264' ? Math.max(1, Math.floor(cpus().length / parallel)) : 0

    let doneFrames = 0
    const report = (): void => {
      // 区間が1つ書けるたびにも空きを見る(短い書き出しは見回りの間隔より先に終わる)
      checkDisk()
      onProgress(
        Math.min(90, (doneFrames / (totalFrames * (withVideo ? 2 : 1))) * 90),
        `書き出し中(${segments.length}区間・${parallel}並列・${encoderText})`
      )
    }
    report()

    const name = (s: Segment, ext: string): string =>
      join(work, `seg_${String(s.index).padStart(5, '0')}.${ext}`)
    // 区間の映像の入れ物(ProRes は MP4 に入らないので .mov)
    const videoExt = format === 'prores' ? 'mov' : 'mp4'
    const jobs: (() => Promise<void>)[] = []
    for (const s of segments) {
      if (withVideo)
        jobs.push(() =>
          withRetry(async () => {
            const graph = buildSegmentVideoGraph(ctx, s)
            await runFfmpeg(
              [
                '-v',
                'error',
                ...graphArgs(withDecoders(graph, alphaDecoders), name(s, 'v.txt')),
                '-an',
                ...NO_SOURCE_METADATA_ARGS,
                ...encodeArgs,
                ...(threadsPerJob > 0 ? ['-threads', String(threadsPerJob)] : []),
                name(s, videoExt)
              ],
              runSignal
            )
            doneFrames += s.endFrame - s.startFrame
            report()
          }, runSignal)
        )
      jobs.push(() =>
        withRetry(async () => {
          const graph = buildSegmentAudioGraph(ctx, s)
          await runFfmpeg(
            [
              '-v',
              'error',
              ...graphArgs(graph, name(s, 'a.txt')),
              '-vn',
              ...NO_SOURCE_METADATA_ARGS,
              ...SEGMENT_AUDIO_CODEC_ARGS,
              '-ar',
              String(OUTPUT_SAMPLE_RATE),
              name(s, 'wv')
            ],
            runSignal
          )
          doneFrames += s.endFrame - s.startFrame
          report()
        }, runSignal)
      )
    }
    await runPool(jobs, parallel)

    // --- 連結 ---
    // 音は全体を1本のファイルに写さず、区間の WavPack を concat demuxer で直接読む
    // (前は full.wav に写していたので、区間の音と同じ大きさがもう1つ要り、4GiB を越えると壊れうる)
    const listLine = (p: string): string => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
    const videoList = join(work, 'video.txt')
    const audioList = join(work, 'audio.txt')
    if (withVideo)
      writeFileSync(videoList, segments.map((s) => listLine(name(s, videoExt))).join('\n'), 'utf-8')
    writeFileSync(audioList, segments.map((s) => listLine(name(s, 'wv'))).join('\n'), 'utf-8')
    const audioInput = ['-f', 'concat', '-safe', '0', '-i', audioList]

    const audioFilter: string[] = []
    if (options.loudnessNormalization) {
      onProgress(91, '音量を測定中')
      const { stderr } = await runFfmpeg(
        [
          '-v',
          'info',
          ...audioInput,
          '-af',
          loudnormMeasureFilter(options.loudnessTarget),
          '-f',
          'null',
          '-'
        ],
        runSignal
      )
      // 音が全編無音(音声の無い企画)なら正規化しない(無音に loudnorm を掛けると AAC が止まる)
      if (!loudnormMeasuredSilence(stderr)) {
        const measured: LoudnessMeasurement | null = parseLoudnormMeasurement(stderr)
        // 書き出しと同じ AAC にして、大きさとトゥルーピークを測りながら合わせる(`fitEncodedLoudness`)
        let pass = 0
        const filter = await fitEncodedLoudness(
          options.loudnessTarget ?? 'web',
          measured,
          async (f) => {
            pass++
            onProgress(Math.min(95, 92 + pass), '音量を合わせ中')
            const r = await measureEncodedLoudness(
              ffmpegPath,
              audioInput,
              `${f},${AUDIO_FORMAT}`,
              runSignal
            )
            if (runSignal.aborted) throw new Error('EXPORT_CANCELED')
            return r
          },
          // 前のやり方(速いやり方で合わないときだけ使う): AAC にする前の音を loudnorm で測る
          async (f) => {
            pass++
            onProgress(Math.min(95, 92 + pass), '音量を合わせ中')
            const { stderr: s } = await runFfmpeg(
              [
                '-v',
                'info',
                ...audioInput,
                '-af',
                `${f},${loudnormMeasureFilter(options.loudnessTarget)}`,
                '-f',
                'null',
                '-'
              ],
              runSignal
            )
            return parseLoudnormMeasurement(s)
          }
        )
        audioFilter.push('-af', `${filter},${AUDIO_FORMAT}`)
      }
    }

    onProgress(96, '仕上げ中')
    await runFfmpeg(finalMuxArgs(format, videoList, audioInput, audioFilter, outputPath), runSignal)
    onProgress(100, '完了')
    return {
      segments: segments.length,
      encoder,
      parallel,
      frames: totalFrames,
      startFrame: snapped?.startFrame ?? 0
    }
  } catch (e) {
    if (runSignal.aborted) rmSync(outputPath, { force: true })
    // ディスクの空きで止めたときは、取り消しではなくその理由で失敗させる
    if (lowDiskError && !outerSignal?.aborted) throw lowDiskError
    throw e
  } finally {
    clearInterval(watch)
    // Windows では止めた直後にまだ掴まれていることがあるので、少し待ってやり直す
    // 消せなくても、書き出しの成否(と元の失敗の理由)は変えない。残ったものは次の起動で消す
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      forgetOutsideWorkDir(work)
    } catch (e) {
      console.warn('区間ごとの書き出しの一時フォルダを消せませんでした', work, e)
    }
  }
}

/**
 * 区間ごとの音の形式: WavPack(浮動小数のまま可逆。0 dBFS を越える山も切らない)。
 * 速さ優先の段(1)で、無圧縮の 32bit WAV の 4〜7 割(実測: 記録映像の音 60 秒で 23.0MB → 8.6MB、
 * 書くのは 0.5 秒。AAC から戻した雑音の多い音では 0.67 倍)。段 0 は 6 割強で縮みが悪く、
 * 段 2 以上は数倍遅いのに 1 割も縮まない
 */
const SEGMENT_AUDIO_CODEC_ARGS = ['-c:a', 'wavpack', '-compression_level', '1']

/** 速さを変えた音を先に書く長さ(秒)の合計(ディスクの見込み用) */
function stretchedSeconds(seq: Sequence): number {
  let sec = 0
  for (const t of seq.audioTracks) {
    if (t.muted) continue
    for (const item of t.items) {
      const speed = item.speed > 0 ? item.speed : 1
      if (Math.abs(speed - 1) > RESAMPLE_SPEED_LIMIT)
        sec += frameToSeconds(seq, item.durationFrames) + STRETCH_TAIL_SEC
    }
  }
  return sec
}

/** ディスクの空き(バイト)。測れなければ例外 */
function freeBytes(path: string): number {
  const s = statfsSync(path)
  return Number(s.bavail) * Number(s.bsize)
}

function safeFree(diskFree: (path: string) => number, path: string): number | null {
  try {
    const v = diskFree(path)
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** 2つのフォルダが同じドライブ(ファイルシステム)にあるか。分からなければ同じとみなす(多めに見る) */
function sameVolume(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev
  } catch {
    return true
  }
}

/** 一時フォルダを作る(場所は `chooseWorkLocation`)。どこにも入らなければ、始める前に分かる文面で止める */
function makeWorkDir(
  base: string,
  outputPath: string,
  need: { temp: number; output: number },
  diskFree: (path: string) => number
): string {
  const outDir = dirname(outputPath)
  const choice = chooseWorkLocation({
    need,
    baseFree: safeFree(diskFree, base),
    outFree: safeFree(diskFree, outDir),
    together: sameVolume(base, outDir)
  })
  if ('error' in choice) throw new Error(choice.error)
  if (choice.where === 'base') return mkdtempSync(join(base, 've-seg-'))
  // 書き出し先のフォルダに置くときは、隠しフォルダにする。落ちて残ったときに次の起動で消せるよう、
  // 作った場所を記録しておく(OS の一時フォルダの外なので、名前で探して消すことはしない)
  const dir = mkdtempSync(join(outDir, '.ve-seg-'))
  rememberOutsideWorkDir(dir)
  return dir
}

/**
 * OS の一時フォルダの外に作った作業場の記録。既定はアプリの設定の置き場(userData)。
 * 試験(Electron の外)では OS の一時フォルダに置く
 */
let outsideWorkRegistry: string | null = null
export function outsideWorkRegistryPath(): string {
  if (outsideWorkRegistry) return outsideWorkRegistry
  try {
    if (app?.getPath) return join(app.getPath('userData'), 'export-work-dirs.json')
  } catch {
    // Electron の外
  }
  return join(tmpdir(), 've-export-work-dirs.json')
}
/** 試験用: 記録の置き場を差し替える(null で既定に戻す) */
export function setOutsideWorkRegistryPath(path: string | null): void {
  outsideWorkRegistry = path
}

function readOutsideWorkDirs(): string[] {
  try {
    const v: unknown = JSON.parse(readFileSync(outsideWorkRegistryPath(), 'utf-8'))
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeOutsideWorkDirs(dirs: string[]): void {
  try {
    writeFileSync(outsideWorkRegistryPath(), JSON.stringify(dirs), 'utf-8')
  } catch {
    // 記録できなくても書き出しは止めない
  }
}

function rememberOutsideWorkDir(dir: string): void {
  writeOutsideWorkDirs([...readOutsideWorkDirs().filter((d) => d !== dir), dir])
}

function forgetOutsideWorkDir(dir: string): void {
  const dirs = readOutsideWorkDirs()
  if (dirs.includes(dir)) writeOutsideWorkDirs(dirs.filter((d) => d !== dir))
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code
}

/**
 * stat が ENOENT になったパスが、本当に無いか。一番近くの在る祖先がフォルダなら「無い」と決める。
 * ENOENT だけでは決められない:
 * - Windows では、ファイルの下のパス(file\sub)の stat も、Linux・macOS の ENOTDIR でなく ENOENT になる
 * - 切れたネットワークドライブ・外したドライブ(E:\)・つながらない共有(\\nas\share)も ENOENT になる
 * 祖先がフォルダでない(ファイル)・根まで無い・祖先を調べられない(権限など)ときは「決められない」(false)。
 * `pathApi`・`statFn` は試験用(path.win32 と、Windows の stat の振る舞いを真似たもの)
 */
export async function reallyMissing(
  path: string,
  pathApi: Pick<typeof nodePath, 'dirname'> = nodePath,
  statFn: (p: string) => Promise<{ isDirectory(): boolean }> = stat
): Promise<boolean> {
  let cur = path
  for (;;) {
    const parent = pathApi.dirname(cur)
    // 根(C:\・\\nas\share\・/)まで無い: ドライブ・共有が切れている
    if (parent === cur) return false
    try {
      return (await statFn(parent)).isDirectory()
    } catch (e) {
      if (errCode(e) !== 'ENOENT') return false
      cur = parent
    }
  }
}

/** 記録の上限(消せないまま残るもの・利用者が消したものが溜まり続けないように) */
const MAX_OUTSIDE_WORK_RECORDS = 50

/**
 * 記録した作業場(書き出し先のフォルダに作った `.ve-seg-*`)のうち、半日より古いものを消す。
 * 書き出し先は切れたネットワークドライブのこともあり、同期の stat はそこで main を止めうるので、
 * すべて非同期で後回しに調べる。記録から外すのは、消せたとき・本当に無いとき(reallyMissing)と、
 * 名前が `.ve-seg-` で始まらない(自分の作ったものではない)ときだけ。名前の違うものは記録が壊れていても消さない
 */
export async function cleanupOutsideWorkDirs(now = Date.now()): Promise<void> {
  const removed = new Set<string>()
  for (const dir of readOutsideWorkDirs()) {
    const name = dir.split(/[\\/]/).pop() ?? ''
    if (!name.startsWith('.ve-seg-')) {
      removed.add(dir)
      continue
    }
    try {
      const st = await stat(dir)
      if (now - st.mtimeMs <= 12 * 3600 * 1000) continue
      await rm(dir, { recursive: true, force: true })
      removed.add(dir)
    } catch (e) {
      // 本当に無ければ外す。それ以外(切れたドライブ・権限・ファイルの下のパス)は次の起動でまた試す。
      // ENOENT だけでは決めない(Windows はファイルの下のパスも、切れたドライブも ENOENT になる)
      if (errCode(e) === 'ENOENT' && (await reallyMissing(dir))) removed.add(dir)
    }
  }
  // 調べている間に書き出しが記録を足していることがあるので、読み直してから外す
  const left = readOutsideWorkDirs().filter((d) => !removed.has(d))
  writeOutsideWorkDirs(left.slice(-MAX_OUTSIDE_WORK_RECORDS))
}

/**
 * 前回、処理の途中でアプリを閉じた(落ちた)ときに残った一時フォルダの名前の頭。
 * - 区間の書き出しの作業場・テロップの層の画像の置き場(長尺だと数 GB になる)
 * - 波形・サムネイル・フレーム・書き出しのグラフや字幕の作業場(1つは小さいが、閉じるたびに
 *   作りかけのぶんが残る。実測: 開発機の一時フォルダに `ve-wave-*` が 95個残っていた)
 */
const STALE_TEMP_PREFIXES = [
  've-seg-',
  TELOP_STAGE_PREFIX,
  've-wave-',
  've-thumb-',
  've-frame-',
  've-graph-',
  've-subs-',
  // 文字起こしの音声(f32 の PCM で大きい)・自動の切り出し・書体の測り
  've-whisper-',
  've-crop-',
  've-fontprobe-'
]

/**
 * 前回の残りの一時フォルダを消す。いま動いている処理のものを消さないよう、半日より古いものだけ
 */
export function cleanupStaleSegmentDirs(now = Date.now(), base = tmpdir()): void {
  // 書き出し先に作ったもの: 非同期で後回しに(切れたドライブで止まらないように)
  void cleanupOutsideWorkDirs(now).catch(() => {})
  let names: string[]
  try {
    names = readdirSync(base)
  } catch {
    return
  }
  for (const name of names) {
    if (!STALE_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    const dir = join(base, name)
    try {
      if (now - statSync(dir).mtimeMs > 12 * 3600 * 1000)
        rmSync(dir, { recursive: true, force: true })
    } catch {
      // 消せないものは次の起動で
    }
  }
}

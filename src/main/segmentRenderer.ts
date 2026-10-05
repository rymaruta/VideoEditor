import { trackProcess } from './liveProcesses'
import { loudnormApplyFilter, loudnormMeasureFilter, type LoudnessTarget } from '@shared/loudness'
import { spawn } from 'child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { cpus, tmpdir } from 'os'
import { join } from 'path'
import type { QualityPreset, TextOverlay } from '@shared/types'
import type { ProjectV2, Sequence } from '@shared/sequence/types'
import {
  defaultSegmentOptions,
  planSegments,
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
  crfForQuality,
  ffmpegPath,
  parseLoudnormMeasurement,
  probeAudioChannels,
  type LoudnessMeasurement
} from './ffmpegService'
import { measureWideAdvances } from './fontMetrics'
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
 * 2. 区間ごとに映像(最終の形式で直接エンコード)と音声(無圧縮 WAV)を**並列に**書き出す
 * 3. 映像は concat demuxer で**再エンコードせずに**繋ぎ、音声は WAV を繋いでから
 *    (必要ならラウドネスを2パスで測って)AAC にし、1つの mp4 にまとめる
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
}

export interface SegmentedExportResult {
  segments: number
  encoder: VideoEncoder
  parallel: number
  /** 書き出した映像のフレーム数(シーケンスの尺と一致する) */
  frames: number
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
      child.kill('SIGKILL')
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
    args.push('-ss', String(Math.max(0, input.seek)), '-t', String(Math.max(0.001, input.duration)))
    args.push('-i', input.path)
  })
  // 理由は v1 の書き出しと同じ(コマンドラインの長さの上限・空白を含むパス)
  args.push('-filter_complex_script', graphPath, '-map', graph.outLabel)
  return args
}

// ------------------------------------------------------------------ エンコーダ

let encoderProbe: Promise<VideoEncoder> | null = null

/**
 * NVENC が**実際に**使えるかを、小さな絵を1回エンコードして確かめる。
 * `-encoders` の一覧に載っていても、ドライバが古い・GPU が無い環境では開けない。
 * 結果はプロセスの間だけ覚える。
 */
export function detectVideoEncoder(): Promise<VideoEncoder> {
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
  const onProgress = options.onProgress ?? ((): void => {})
  const seq = project.sequence
  const fps = fpsExpr(seq)
  const segments = planSegments(
    seq,
    options.segmentOptions ?? defaultSegmentOptions(seq.fps.num / seq.fps.den)
  )
  if (segments.length === 0) throw new Error('タイムラインにクリップがありません')
  const totalFrames = segments[segments.length - 1].endFrame

  const encoder =
    options.encoder && options.encoder !== 'auto' ? options.encoder : await detectVideoEncoder()
  const parallel = Math.max(1, options.maxParallel ?? defaultParallelism(encoder))

  const work = mkdtempSync(join(tmpdir(), 've-seg-'))
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

    // テロップ: 画面のプロセスが描いた層があればそれを使う(画面と同じ絵になる)。
    // 無ければシーケンス全体で1つの ASS にし、各区間は時刻をずらして使う
    let assPath: string | undefined
    let telopLayer: GraphContext['telopLayer']
    // 画像は描きながら main の置き場へ書いてある(`stagedId`)。バイト列で来たときだけここへ書く
    const layer = options.telopLayer ? materializeTelopLayer(options.telopLayer, () => work) : null
    if (layer) {
      if (layer.width !== seq.width || layer.height !== seq.height) {
        throw new Error('テロップの画像の大きさが書き出しの解像度と合いません')
      }
      telopLayer = { runs: layer.runs, imagePaths: layer.imagePaths }
    }
    // `null` は「画面のプロセスが描いた結果、出すテロップが無かった」。ASS で描き直さない
    const overlays = telopLayer || options.telopLayer === null ? [] : telopsAsOverlays(seq)
    if (overlays.length > 0) {
      const wideEmByFont = await measureWideAdvances(ffmpegPath, overlays)
      const canvas = textCanvasSize(seq.width >= seq.height ? '16:9' : '9:16')
      assPath = join(work, 'telop.ass')
      writeFileSync(assPath, buildAssContent(overlays, canvas.w, canvas.h, wideEmByFont), 'utf-8')
    }

    const ctx: GraphContext = { sequence: seq, assetsById, audioChannels, assPath, telopLayer }
    const encodeArgs = videoEncodeArgs(encoder, quality, fps)
    const threadsPerJob =
      encoder === 'libx264' ? Math.max(1, Math.floor(cpus().length / parallel)) : 0

    let doneFrames = 0
    const report = (): void =>
      onProgress(
        Math.min(90, (doneFrames / (totalFrames * 2)) * 90),
        `書き出し中(${segments.length}区間・${parallel}並列・${encoderLabel(encoder)})`
      )
    report()

    const name = (s: Segment, ext: string): string =>
      join(work, `seg_${String(s.index).padStart(5, '0')}.${ext}`)
    const jobs: (() => Promise<void>)[] = []
    for (const s of segments) {
      jobs.push(() =>
        withRetry(async () => {
          const graph = buildSegmentVideoGraph(ctx, s)
          await runFfmpeg(
            [
              '-v',
              'error',
              ...graphArgs(graph, name(s, 'v.txt')),
              '-an',
              ...encodeArgs,
              ...(threadsPerJob > 0 ? ['-threads', String(threadsPerJob)] : []),
              name(s, 'mp4')
            ],
            signal
          )
          doneFrames += s.endFrame - s.startFrame
          report()
        }, signal)
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
              '-c:a',
              'pcm_f32le',
              '-ar',
              String(OUTPUT_SAMPLE_RATE),
              name(s, 'wav')
            ],
            signal
          )
          doneFrames += s.endFrame - s.startFrame
          report()
        }, signal)
      )
    }
    await runPool(jobs, parallel)

    // --- 連結 ---
    const listLine = (p: string): string => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
    const videoList = join(work, 'video.txt')
    const audioList = join(work, 'audio.txt')
    writeFileSync(videoList, segments.map((s) => listLine(name(s, 'mp4'))).join('\n'), 'utf-8')
    writeFileSync(audioList, segments.map((s) => listLine(name(s, 'wav'))).join('\n'), 'utf-8')
    const fullWav = join(work, 'full.wav')
    onProgress(91, '音声をつなぎ中')
    await runFfmpeg(
      ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', audioList, '-c', 'copy', fullWav],
      signal
    )

    let measured: LoudnessMeasurement | null = null
    if (options.loudnessNormalization) {
      onProgress(93, '音量を測定中')
      const { stderr } = await runFfmpeg(
        [
          '-v',
          'info',
          '-i',
          fullWav,
          '-af',
          loudnormMeasureFilter(options.loudnessTarget),
          '-f',
          'null',
          '-'
        ],
        signal
      )
      measured = parseLoudnormMeasurement(stderr)
    }
    const audioFilter: string[] = []
    if (options.loudnessNormalization) {
      // 2パス目の掛け方は v1 の書き出しと同じ(理由もそちらのコメント)
      const loudnorm = loudnormApplyFilter(options.loudnessTarget, measured)
      audioFilter.push('-af', `${loudnorm},${AUDIO_FORMAT}`)
    }

    onProgress(96, '仕上げ中')
    await runFfmpeg(
      [
        '-v',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        videoList,
        '-i',
        fullWav,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-c:v',
        'copy',
        ...audioFilter,
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outputPath
      ],
      signal
    )
    onProgress(100, '完了')
    return { segments: segments.length, encoder, parallel, frames: totalFrames }
  } catch (e) {
    if (signal?.aborted) rmSync(outputPath, { force: true })
    throw e
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
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
  've-subs-'
]

/**
 * 前回の残りの一時フォルダを消す。いま動いている処理のものを消さないよう、半日より古いものだけ
 */
export function cleanupStaleSegmentDirs(now = Date.now(), base = tmpdir()): void {
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

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { open, readFile, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { readPcm, PCM_ABORTED, PCM_ALIGN_FILTER } from './audioPcm'
import { ffSeconds } from './ffArgs'
import {
  WAVE_BASE_RATE,
  WAVE_BASE_VERSION,
  WAVE_PEAKS_MAX_COLUMNS,
  WAVE_READ_RATE,
  WaveBaseBuilder,
  WavePeakAccumulator,
  aggregateBase,
  applyChannelPick,
  baseIsFineEnough,
  decodeWaveBase,
  encodeWaveBase,
  peakSampleRate,
  pickFromPeaks,
  waveBaseBytes,
  wavePeaksBytes,
  type WaveBase,
  type WavePeaks
} from '@shared/waveformPeaks'

/**
 * タイムラインの細かい波形の値(列ごとの符号付きの最大・最小と RMS)を返す。
 *
 * 素材ごとに一定の細かさ(1 秒 100 列)の「素の値」を 1 回だけ作ってディスクに覚え
 * (`cachedEnvelope` と同じやり方)、拡大・トリムでは ffmpeg を起こさずにそこから集計して返す。
 * 素の値より細かく頼まれたとき(拡大 125% 超)だけ、頼まれた短い範囲を読み直す。
 *
 * - 素の値を作る ffmpeg は同時に 2 本まで(新しく頼まれた素材から)。待っている頼みが全部止められたら、
 *   待ち行列から外すか ffmpeg を止める。作れなかった素材は 30 秒覚え、見えるたびに全体を読み直さない
 * - 読み直しも同時に 2 本まで。止められた頼みは走らせない・走っていれば止める
 * - ディスク: `<パスの印>-<中身の鍵>.wpk`。起動時に書きかけ(.tmp)を消し、使ったら更新時刻を触り、
 *   合計 1GB を越えたら使っていないものから消す。同じパスの古い中身の素の値は、新しく作ったときに消す
 *
 * 見積もり(3 時間の素材): 素の値はステレオで約 13MB(モノラルは約 6.5MB)をディスクとメモリに。
 * メモリに置くのは合計 `memoryBytes`(既定 96MB)まで、古い素材から捨てる。読み直した値は合計 32MB まで。
 */

/** 生の音を流させて、列ごとに集計する(溜めない)。区間の扱いは画像の波形と同じ */
export async function generateWaveformPeaks(
  ffmpegPath: string,
  filePath: string,
  start: number,
  end: number,
  columns: number,
  options: { channels?: number; signal?: AbortSignal } = {}
): Promise<WavePeaks> {
  const duration = Math.max(0.05, end - start)
  const cols = Math.max(1, Math.min(WAVE_PEAKS_MAX_COLUMNS, Math.round(columns)))
  const rate = peakSampleRate(cols, duration)
  const ch = options.channels === 1 ? 1 : 2
  const acc = new WavePeakAccumulator(cols, ch, duration * rate)
  await readPcm(
    ffmpegPath,
    [
      '-ss',
      ffSeconds(start),
      '-t',
      ffSeconds(duration),
      '-i',
      filePath,
      '-vn',
      '-af',
      `${PCM_ALIGN_FILTER},apad=whole_dur=${ffSeconds(duration)}`,
      '-ac',
      String(ch),
      '-ar',
      String(rate),
      '-f',
      'f32le',
      'pipe:1'
    ],
    (s) => acc.push(s),
    options.signal
  )
  return acc.finish()
}

/** 素材の音の本数(1 か 2。3 本以上は 2 本に混ぜて読む)。分からなければ 2 */
export function probeAudioChannels(ffprobePath: string, filePath: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=channels',
        '-of',
        'csv=p=0',
        filePath
      ],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        const n = Number(String(stdout).trim().split(/\s+/)[0])
        resolve(!err && n === 1 ? 1 : 2)
      }
    )
  })
}

/** 素の値を作る(素材を頭から終わりまで 1 回読む)。`signal` で止められる */
export async function buildWaveBase(
  ffmpegPath: string,
  filePath: string,
  channels: number,
  signal?: AbortSignal
): Promise<WaveBase> {
  const ch = channels === 1 ? 1 : 2
  const builder = new WaveBaseBuilder(WAVE_READ_RATE, ch, WAVE_BASE_RATE)
  await readPcm(
    ffmpegPath,
    [
      '-i',
      filePath,
      '-vn',
      '-af',
      PCM_ALIGN_FILTER,
      '-ac',
      String(ch),
      '-ar',
      String(WAVE_READ_RATE),
      '-f',
      'f32le',
      'pipe:1'
    ],
    (s) => builder.push(s),
    signal
  )
  return builder.finish()
}

export interface WaveformPeaksService {
  /** `signal` で止めると `PCM_ABORTED` で失敗する */
  get(
    filePath: string,
    start: number,
    end: number,
    columns: number,
    signal?: AbortSignal
  ): Promise<WavePeaks>
  /** 覚えている素の値の大きさの合計(試験・記録用) */
  readonly memoryBytes: number
  /** 素の値を作っている数・待っている数・これまでの ffmpeg の最大の同時数(読み直しを含む。試験・記録用) */
  readonly building: { running: number; waiting: number; peak: number }
}

/** 素の値を同時に作る数(10/09 版の波形の絵と同じ 2 本) */
export const WAVE_BASE_CONCURRENCY = 2
/** 作れなかった素材を覚えておく時間(見えるたびに全体を読み直さない) */
export const WAVE_BASE_FAILURE_MS = 30_000
/** ディスクの素の値の合計の上限。越えたら使っていない(更新時刻の古い)ものから消す */
export const WAVE_BASE_DISK_BYTES = 1024 * 1024 * 1024
/** この長さ(秒)までの範囲は、素の値がまだ無ければ作らずにその範囲だけ読む */
export const WAVE_DIRECT_MAX_SEC = 120
/** 素の値を作っている途中で頼みが無くなってから、止めるまで待つ時間(すぐ頼み直されることが多い) */
const ABORT_GRACE_MS = 2000
/** 読み直した細かい値を覚える合計 */
const FINE_CACHE_BYTES = 32 * 1024 * 1024

const abortError = (): Error => new Error(PCM_ABORTED)
const isAbort = (e: unknown): boolean => String(e).includes(PCM_ABORTED)

/** 素材の中身の目印(頭と終わりの 64KB と大きさ)。画面の処理を止めずに読む */
async function fingerprintAsync(path: string, size: number): Promise<string> {
  const SAMPLE = 64 * 1024
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(path, 'r')
    const hash = createHash('sha1').update(String(size))
    const head = Buffer.alloc(Math.min(SAMPLE, size))
    await fh.read(head, 0, head.length, 0)
    hash.update(head)
    if (size > SAMPLE) {
      const tail = Buffer.alloc(Math.min(SAMPLE, size - SAMPLE))
      await fh.read(tail, 0, tail.length, size - tail.length)
      hash.update(tail)
    }
    return hash.digest('hex').slice(0, 16)
  } catch {
    return ''
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** 素材のパスごとのファイル名の頭(上書きした素材の古い素の値を見つけて消すため) */
export function wavePathPrefix(filePath: string): string {
  return createHash('sha1').update(filePath).digest('hex').slice(0, 16)
}

interface BuildJob {
  key: string
  filePath: string
  file: string
  /** 待っている頼み(止められない頼みは null)。全部止められたら作るのをやめる */
  waiters: Set<AbortSignal | null>
  ac: AbortController
  started: boolean
  promise: Promise<WaveBase>
  resolve: (b: WaveBase) => void
  reject: (e: unknown) => void
}

export function createWaveformPeaksService(opts: {
  ffmpegPath: string
  ffprobePath: string
  cacheDir: string
  memoryBytes?: number
  buildConcurrency?: number
  diskBytes?: number
  failureMs?: number
  /** この長さ(秒)までの範囲は、素の値が無ければ作らずに読む(既定 120 秒) */
  directMaxSec?: number
}): WaveformPeaksService {
  const maxBytes = opts.memoryBytes ?? 96 * 1024 * 1024
  const diskLimit = opts.diskBytes ?? WAVE_BASE_DISK_BYTES
  const failureMs = opts.failureMs ?? WAVE_BASE_FAILURE_MS
  const directMax = opts.directMaxSec ?? WAVE_DIRECT_MAX_SEC
  const memory = new Map<string, WaveBase>()
  let bytes = 0
  const jobs = new Map<string, BuildJob>()
  const queue: BuildJob[] = []
  let buildRunning = 0
  let buildPeak = 0
  const buildLimit = Math.max(1, opts.buildConcurrency ?? WAVE_BASE_CONCURRENCY)
  /** 走っている読み直しの数と、待っている読み直し */
  let running = 0
  const waiting: (() => void)[] = []
  /** 素材ごとの音の本数(読み直しのたびに ffprobe を起こさない) */
  const channelMemo = new Map<string, number>()
  const failed = new Map<string, { error: unknown; until: number }>()
  /** 読み直した細かい値(素材の鍵ごと)。同じタイルが見え直すたびに ffmpeg を起こさない */
  const fineCache = new Map<string, { peaks: WavePeaks; size: number }>()
  let fineBytes = 0
  /** パス → 最後に見た stat と鍵(stat が変わらなければ目印を読み直さない) */
  const keyMemo = new Map<string, { stamp: string; key: string }>()

  // 起動時の片付け: 書きかけ(.tmp)を消す
  try {
    for (const f of readdirSync(opts.cacheDir)) {
      if (f.endsWith('.tmp')) rmSync(join(opts.cacheDir, f), { force: true })
    }
  } catch {
    // まだフォルダが無い
  }

  const remember = (key: string, base: WaveBase): void => {
    const size = waveBaseBytes(base)
    if (size > maxBytes) return
    const old = memory.get(key)
    if (old) {
      memory.delete(key)
      bytes -= waveBaseBytes(old)
    }
    memory.set(key, base)
    bytes += size
    while (bytes > maxBytes) {
      const oldest = memory.keys().next().value
      if (oldest === undefined) break
      const b = memory.get(oldest)!
      memory.delete(oldest)
      bytes -= waveBaseBytes(b)
    }
  }

  const keyOf = async (filePath: string): Promise<string> => {
    let st: Awaited<ReturnType<typeof stat>> | null = null
    try {
      st = await stat(filePath)
    } catch {
      // 無い素材は読むところで失敗する
    }
    const stamp = st ? `${st.size}:${st.mtimeMs}:${st.ctimeMs}` : 'missing'
    const memo = keyMemo.get(filePath)
    if (memo && memo.stamp === stamp) return memo.key
    const fp = st ? await fingerprintAsync(filePath, st.size) : ''
    const key = createHash('sha1')
      .update(
        `${filePath}|${stamp}|${fp}|${WAVE_BASE_RATE}|${WAVE_READ_RATE}|v${WAVE_BASE_VERSION}`
      )
      .digest('hex')
    keyMemo.set(filePath, { stamp, key })
    return key
  }

  /** ディスクの素の値を、合計の上限に収める(使った時刻=更新時刻の古いものから消す) */
  const trimDisk = (): void => {
    try {
      const files = readdirSync(opts.cacheDir)
        .filter((f) => f.endsWith('.wpk'))
        .map((f) => {
          const p = join(opts.cacheDir, f)
          const st = statSync(p)
          return { p, size: st.size, mtime: st.mtimeMs }
        })
        .sort((a, b) => a.mtime - b.mtime)
      let total = files.reduce((n, f) => n + f.size, 0)
      for (const f of files) {
        if (total <= diskLimit) break
        rmSync(f.p, { force: true })
        total -= f.size
      }
    } catch {
      // 片付けられなくても動く
    }
  }

  const touch = (file: string): void => {
    try {
      const now = new Date()
      utimesSync(file, now, now)
    } catch {
      // 触れなくても動く
    }
  }

  /** 同じパスの、今の鍵ではない素の値(上書きする前の素材のもの)を消す */
  const removeStale = (filePath: string, keepFile: string): void => {
    const prefix = `${wavePathPrefix(filePath)}-`
    try {
      for (const f of readdirSync(opts.cacheDir)) {
        const p = join(opts.cacheDir, f)
        if (f.startsWith(prefix) && f.endsWith('.wpk') && p !== keepFile) rmSync(p, { force: true })
      }
    } catch {
      // 片付けられなくても動く
    }
  }

  const runJob = async (job: BuildJob): Promise<void> => {
    try {
      const channels = await probeAudioChannels(opts.ffprobePath, job.filePath)
      if (job.ac.signal.aborted) throw abortError()
      const base = await buildWaveBase(opts.ffmpegPath, job.filePath, channels, job.ac.signal)
      try {
        mkdirSync(dirname(job.file), { recursive: true })
        const tmp = `${job.file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
        writeFileSync(tmp, encodeWaveBase(base))
        try {
          renameSync(tmp, job.file)
        } catch {
          rmSync(tmp, { force: true })
        }
        removeStale(job.filePath, job.file)
        trimDisk()
      } catch {
        // ディスクに書けなくても、今回は使える
      }
      remember(job.key, base)
      job.resolve(base)
    } catch (e) {
      if (!isAbort(e)) failed.set(job.key, { error: e, until: Date.now() + failureMs })
      job.reject(e)
    } finally {
      if (jobs.get(job.key) === job) jobs.delete(job.key)
      buildRunning--
      next()
      pump()
    }
  }

  const pump = (): void => {
    // 読み直し(短い)を先に回し、空いていれば素の値を作る。ffmpeg は全部で同時に 2 本まで
    while (buildRunning + running < buildLimit && waiting.length === 0 && queue.length > 0) {
      // 新しく頼まれたものを先に(今見ている所の素材から作る)
      const job = queue.pop()!
      job.started = true
      buildRunning++
      buildPeak = Math.max(buildPeak, buildRunning + running)
      void runJob(job)
    }
  }

  /** 頼みを 1 つ外す。誰も待たなくなったら、待ち行列から外すか ffmpeg を止める */
  const leave = (job: BuildJob, signal: AbortSignal | null): void => {
    job.waiters.delete(signal)
    if (job.waiters.size > 0) return
    if (job.started) {
      // 走っているものは少し待ってから止める。拡大・縮小では前の段の頼みが止められ、すぐ同じ素材が
      // 頼み直される(3 時間の素材を作り直しから始めていた)。その間に誰か来れば続ける
      setTimeout(() => {
        if (job.waiters.size > 0 || job.ac.signal.aborted) return
        // 止めると決めたら、新しい頼みがこの止まる仕事に乗らないよう外しておく
        if (jobs.get(job.key) === job) jobs.delete(job.key)
        job.ac.abort()
      }, ABORT_GRACE_MS)
      return
    }
    const i = queue.indexOf(job)
    if (i >= 0) queue.splice(i, 1)
    jobs.delete(job.key)
    job.reject(abortError())
  }

  /** 素の値。`build` が false なら、覚えている(メモリ・ディスク)ときだけ返し、作らない */
  const baseFor = async (
    filePath: string,
    signal: AbortSignal | undefined,
    build: boolean
  ): Promise<WaveBase | null> => {
    const key = await keyOf(filePath)
    if (signal?.aborted) throw abortError()
    const hit = memory.get(key)
    if (hit) {
      memory.delete(key)
      memory.set(key, hit)
      return hit
    }
    const fail = failed.get(key)
    if (fail) {
      if (fail.until > Date.now()) throw fail.error
      failed.delete(key)
    }
    const file = join(opts.cacheDir, `${wavePathPrefix(filePath)}-${key}.wpk`)
    let job = jobs.get(key)
    if (!job) {
      try {
        const disk = decodeWaveBase(new Uint8Array(await readFile(file)))
        if (disk) {
          touch(file)
          remember(key, disk)
          return disk
        }
        rmSync(file, { force: true })
      } catch {
        // 覚えていなければ作る
      }
      job = jobs.get(key)
    }
    if (!job && !build) return null
    if (!job) {
      let resolve!: (b: WaveBase) => void
      let reject!: (e: unknown) => void
      const promise = new Promise<WaveBase>((res, rej) => {
        resolve = res
        reject = rej
      })
      // 誰も受け取らない失敗で落ちないように
      promise.catch(() => {})
      job = {
        key,
        filePath,
        file,
        waiters: new Set(),
        ac: new AbortController(),
        started: false,
        promise,
        resolve,
        reject
      }
      jobs.set(key, job)
      queue.push(job)
    } else {
      // また頼まれたら前へ(新しく頼まれたもの扱い)
      const i = queue.indexOf(job)
      if (i >= 0) {
        queue.splice(i, 1)
        queue.push(job)
      }
    }
    const j = job
    j.waiters.add(signal ?? null)
    pump()
    if (!signal) return j.promise
    return new Promise<WaveBase>((resolve, reject) => {
      const onAbort = (): void => {
        leave(j, signal)
        reject(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      j.promise.then(
        (b) => {
          signal.removeEventListener('abort', onAbort)
          j.waiters.delete(signal)
          resolve(b)
        },
        (e) => {
          signal.removeEventListener('abort', onAbort)
          j.waiters.delete(signal)
          reject(e)
        }
      )
    })
  }

  // 読み直しは、素の値を作るのと合わせて同時に 2 本まで。待っている間に止められた頼みは走らせない
  const next = (): void => {
    if (buildRunning + running >= buildLimit) return
    const w = waiting.shift()
    if (w) w()
  }
  const acquire = (signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const go = (): void => {
        if (signal?.aborted) {
          reject(abortError())
          next()
          return
        }
        running++
        buildPeak = Math.max(buildPeak, buildRunning + running)
        resolve()
      }
      if (buildRunning + running < buildLimit && waiting.length === 0) go()
      else waiting.push(go)
    })
  const release = (): void => {
    running--
    next()
    pump()
  }

  const rememberFine = (key: string, peaks: WavePeaks): void => {
    const size = wavePeaksBytes(peaks)
    fineCache.set(key, { peaks, size })
    fineBytes += size
    while (fineBytes > FINE_CACHE_BYTES) {
      const oldest = fineCache.keys().next().value
      if (oldest === undefined) break
      fineBytes -= fineCache.get(oldest)!.size
      fineCache.delete(oldest)
    }
  }

  return {
    get memoryBytes() {
      return bytes
    },
    get building() {
      return {
        running: buildRunning + running,
        waiting: queue.length + waiting.length,
        peak: buildPeak
      }
    },
    async get(filePath, start, end, columns, signal) {
      if (signal?.aborted) throw abortError()
      // 短い範囲(2 分まで)は、素の値がまだ無ければ作らずにその範囲だけ読む
      // (10 分の素材から 4 秒ずつ切った 60 本で、60 本ぶん全体を読んでいた)
      const base = await baseFor(filePath, signal, end - start > directMax)
      if (signal?.aborted) throw abortError()
      // どの中身の素材から作ったか(画面の覚え場所の鍵に足す)
      const sourceKey = keyMemo.get(filePath)?.key
      if (base && baseIsFineEnough(start, end, columns, base.rate)) {
        return { ...aggregateBase(base, start, end, columns), sourceKey }
      }
      const fineKey = `${sourceKey}|${start}|${end}|${columns}`
      const cached = fineCache.get(fineKey)
      if (cached) {
        fineCache.delete(fineKey)
        fineCache.set(fineKey, cached)
        return cached.peaks
      }
      let channels = base?.sourceChannels ?? (sourceKey ? channelMemo.get(sourceKey) : undefined)
      if (channels === undefined) {
        channels = await probeAudioChannels(opts.ffprobePath, filePath)
        if (sourceKey) channelMemo.set(sourceKey, channels)
      }
      await acquire(signal)
      try {
        const fine = await generateWaveformPeaks(opts.ffmpegPath, filePath, start, end, columns, {
          channels,
          signal
        })
        const pick = base ? base.pick : pickFromPeaks(fine)
        const peaks = { ...applyChannelPick(fine, pick), sourceKey }
        rememberFine(fineKey, peaks)
        return peaks
      } catch (e) {
        // 読めなかった素材は短い間覚える(見えるたびに読み直さない)
        if (!isAbort(e) && sourceKey)
          failed.set(sourceKey, { error: e, until: Date.now() + failureMs })
        throw e
      } finally {
        release()
      }
    }
  }
}

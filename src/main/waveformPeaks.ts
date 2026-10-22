import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { readPcm, PCM_ABORTED, PCM_ALIGN_FILTER } from './audioPcm'
import { ffSeconds } from './ffArgs'
import { contentFingerprint } from './fileFingerprint'
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
  waveBaseBytes,
  type WaveBase,
  type WavePeaks
} from '@shared/waveformPeaks'

/**
 * タイムラインの細かい波形の値(列ごとの符号付きの最大・最小と RMS)を返す。
 *
 * 素材ごとに一定の細かさ(1 秒 100 列)の「素の値」を 1 回だけ作ってディスクに覚え
 * (`cachedEnvelope` と同じやり方)、拡大・トリムでは ffmpeg を起こさずにそこから集計して返す。
 * 素の値より細かく頼まれたとき(拡大 125% 超)だけ、頼まれた短い範囲を読み直す。読み直しは
 * 同時に 2 本までで、要らなくなった頼み(スクロールで外れたタイル・前の拡大の段)は止められる。
 *
 * 見積もり(3 時間の素材): 素の値はステレオで約 13MB(モノラルは約 6.5MB)をディスクとメモリに。
 * メモリに置くのは合計 `memoryBytes`(既定 96MB)まで、古い素材から捨てる。読み直し 1 回は
 * タイル 1 枚(2048 列。最大拡大で約 6.4 秒ぶん)で、持つのは列の数ぶん(約 50KB)だけ。
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

/** 素の値を作る(素材を頭から終わりまで 1 回読む) */
export async function buildWaveBase(
  ffmpegPath: string,
  filePath: string,
  channels: number
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
    (s) => builder.push(s)
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
}

export function createWaveformPeaksService(opts: {
  ffmpegPath: string
  ffprobePath: string
  cacheDir: string
  memoryBytes?: number
  fineConcurrency?: number
}): WaveformPeaksService {
  const maxBytes = opts.memoryBytes ?? 96 * 1024 * 1024
  const memory = new Map<string, WaveBase>()
  let bytes = 0
  const building = new Map<string, Promise<WaveBase>>()

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

  const keyOf = (filePath: string): string => {
    let stamp = 'missing'
    try {
      const st = statSync(filePath)
      stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`
    } catch {
      // 無い素材は読むところで失敗する
    }
    return createHash('sha1')
      .update(
        `${filePath}|${stamp}|${contentFingerprint(filePath)}|${WAVE_BASE_RATE}|${WAVE_READ_RATE}|v${WAVE_BASE_VERSION}`
      )
      .digest('hex')
  }

  const baseFor = (filePath: string): Promise<WaveBase> => {
    const key = keyOf(filePath)
    const hit = memory.get(key)
    if (hit) {
      memory.delete(key)
      memory.set(key, hit)
      return Promise.resolve(hit)
    }
    const running = building.get(key)
    if (running) return running
    const file = join(opts.cacheDir, `${key}.wpk`)
    const p = (async () => {
      try {
        const disk = decodeWaveBase(new Uint8Array(readFileSync(file)))
        if (disk) return disk
        rmSync(file, { force: true })
      } catch {
        // 覚えていなければ作る
      }
      const channels = await probeAudioChannels(opts.ffprobePath, filePath)
      const base = await buildWaveBase(opts.ffmpegPath, filePath, channels)
      try {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
        writeFileSync(tmp, encodeWaveBase(base))
        try {
          renameSync(tmp, file)
        } catch {
          rmSync(tmp, { force: true })
        }
      } catch {
        // ディスクに書けなくても、今回は使える
      }
      return base
    })()
    building.set(key, p)
    p.then(
      (base) => {
        building.delete(key)
        remember(key, base)
      },
      () => building.delete(key)
    )
    return p
  }

  // 読み直しは同時に 2 本まで。待っている間に止められた頼みは走らせない
  const limit = Math.max(1, opts.fineConcurrency ?? 2)
  let running = 0
  const waiting: (() => void)[] = []
  const acquire = (signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const go = (): void => {
        if (signal?.aborted) {
          reject(new Error(PCM_ABORTED))
          next()
          return
        }
        running++
        resolve()
      }
      if (running < limit) go()
      else waiting.push(go)
    })
  const next = (): void => {
    if (running >= limit) return
    const w = waiting.shift()
    if (w) w()
  }
  const release = (): void => {
    running--
    next()
  }

  return {
    get memoryBytes() {
      return bytes
    },
    async get(filePath, start, end, columns, signal) {
      if (signal?.aborted) throw new Error(PCM_ABORTED)
      const base = await baseFor(filePath)
      if (signal?.aborted) throw new Error(PCM_ABORTED)
      if (baseIsFineEnough(start, end, columns, base.rate)) {
        return aggregateBase(base, start, end, columns)
      }
      await acquire(signal)
      try {
        const fine = await generateWaveformPeaks(opts.ffmpegPath, filePath, start, end, columns, {
          channels: base.sourceChannels,
          signal
        })
        return applyChannelPick(fine, base.pick)
      } finally {
        release()
      }
    }
  }
}

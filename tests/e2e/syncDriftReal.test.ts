/**
 * 長い収録の時計のずれ(ドリフト)を、本物の ffmpeg と本物のファイルで確かめる受け入れテスト。
 *
 * - 頭の 5 分が静か(雑音だけ)なマイクとカメラ: 頭の窓は雑音どうしで、広く探すとたまたま鋭い山が立つ。
 *   ずれの無い2本に、偶然の山から「時計のずれ 70ppm」を作っていた(カメラの頭で 0.12 秒ずれる)
 * - 長い2本(1時間半・40ppm・にぎやかなのは頭の 15 分だけ): 丸ごとの相関でも「合う」と出るが、粗い offset が
 *   頭の値になり中ほどの値にならない。中ほどで詰められず、時計のずれを測らないまま終わりで大きくずれていた
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => ({ cacheDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.cacheDir, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { ffmpegPath, ffprobePath } from '@main/ffmpegService'
import type { SyncInputFile, SyncReport, SyncWorkerMessage } from '@shared/sync/report'

const HAVE_FFMPEG = existsSync(ffmpegPath) && existsSync(ffprobePath)
const SR = 16000

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Burst {
  t: number
  dur: number
  amp: number
  seed: number
}

/**
 * 話し声のような音の粒(0.2〜0.8 秒の雑音の塊が 0.3〜2 秒おき)。quietUntil より前は鳴らさない。
 * busyUntil を渡すと、そこから先はまばら(5〜15 秒おき)にする(にぎやかな頭と、落ち着いた後半)
 */
function world(T: number, quietUntil: number, seed: number, busyUntil = Infinity): Burst[] {
  const r = rng(seed)
  const out: Burst[] = []
  for (let t = quietUntil + r(); t < T; t += t < busyUntil ? 0.3 + r() * 1.7 : 5 + r() * 10)
    out.push({ t, dur: 0.2 + r() * 0.6, amp: 0.05 + r() * 0.25, seed: Math.floor(r() * 1e9) })
  return out
}

/**
 * その機材で録った音。機材の時刻 tc の音は、共通の時刻 start + tc × rate の音(rate = 機材の 1 秒が共通の何秒か)。
 * 雑音は機材ごとに別
 */
function record(
  bursts: readonly Burst[],
  start: number,
  length: number,
  rate: number,
  noiseSeed: number
): Float32Array {
  const n = Math.round(length * SR)
  const out = new Float32Array(n)
  const nz = rng(noiseSeed)
  for (let i = 0; i < n; i++) out[i] = (nz() - 0.5) * 0.004
  for (const b of bursts) {
    const tc = (b.t - start) / rate
    if (tc < 0 || tc >= length) continue
    const r = rng(b.seed)
    const i0 = Math.round(tc * SR)
    const len = Math.round(b.dur * SR)
    for (let k = 0; k < len && i0 + k < n; k++) {
      const env = Math.sin((Math.PI * k) / len)
      out[i0 + k] += b.amp * env * (r() * 2 - 1)
    }
  }
  return out
}

function writeWav(path: string, x: Float32Array): void {
  const buf = Buffer.alloc(44 + x.length * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + x.length * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(x.length * 2, 40)
  const view = new Int16Array(buf.buffer, buf.byteOffset + 44, x.length)
  for (let i = 0; i < x.length; i++) view[i] = Math.round(Math.max(-1, Math.min(1, x[i])) * 32767)
  writeFileSync(path, buf)
}

/** カメラの音として AAC 48kHz の m4a にする(マイクの WAV とは別の形式・別の標本化周波数) */
function writeAac(path: string, x: Float32Array, dir: string): void {
  const wav = join(dir, 'tmp_cam.wav')
  writeWav(wav, x)
  execFileSync(ffmpegPath, ['-y', '-v', 'error', '-i', wav, '-ar', '48000', '-c:a', 'aac', path])
  rmSync(wav, { force: true })
}

async function syncInProcess(files: SyncInputFile[]): Promise<SyncReport> {
  return new Promise<SyncReport>((resolve, reject) => {
    vi.resetModules()
    vi.doMock('worker_threads', () => ({
      parentPort: {
        postMessage: (m: SyncWorkerMessage) => {
          if (m.type === 'done') resolve(m.report)
          else if (m.type === 'error') reject(new Error(m.message))
        }
      },
      workerData: { files, ffmpegPath, cacheDir: state.cacheDir }
    }))
    import('@main/syncWorker').catch(reject)
  }).finally(() => vi.doUnmock('worker_threads'))
}

const input = (
  id: string,
  path: string,
  kind: 'mic' | 'camera',
  duration: number
): SyncInputFile => {
  const st = statSync(path)
  return {
    id,
    path,
    sourceId: kind === 'mic' ? 'M' : 'C',
    sourceKind: kind,
    duration,
    size: st.size,
    mtimeMs: st.mtimeMs
  }
}

/** 共通の時刻 t(マイクの時刻)に、カメラの置き方で見たカメラの時刻と、本当のカメラの時刻の差(秒) */
function placementError(report: SyncReport, t: number, camStart: number, camRate: number): number {
  const m = report.placements.find((p) => p.id === 'mic')!
  const c = report.placements.find((p) => p.id === 'cam')!
  const common = m.start + t / (m.rate || 1)
  const placedCam = (common - c.start) * (c.rate || 1)
  const trueCam = (t - camStart) / camRate
  return placedCam - trueCam
}

describe.skipIf(!HAVE_FFMPEG)('長い収録の時計のずれ', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 've-syncdrift-'))
    state.cacheDir = join(dir, 'userdata')
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('頭が静かで頭の窓が雑音どうしでも、ずれの無い2本に時計のずれを作らない', async () => {
    const T = 3600
    const CAM_START = 30
    const CAM_LEN = 3500
    const w = world(T, 300, 7)
    const micPath = join(dir, 'quiet_mic.wav')
    writeWav(micPath, record(w, 0, T, 1, 11))
    const errors: number[] = []
    for (const seed of [21, 22, 23, 24, 25, 26]) {
      const camPath = join(dir, `quiet_cam${seed}.m4a`)
      writeAac(camPath, record(w, CAM_START, CAM_LEN, 1, seed), dir)
      const report = await syncInProcess([
        input('mic', micPath, 'mic', T),
        input('cam', camPath, 'camera', CAM_LEN)
      ])
      rmSync(camPath, { force: true })
      const pair = report.pairs[0]
      const worst = Math.max(
        ...[400, 1800, 3400].map((t) => Math.abs(placementError(report, t, CAM_START, 1)))
      )
      console.log(`seed ${seed}: drift ${pair?.driftPpm?.toFixed(1)}ppm worst ${worst.toFixed(4)}s`)
      errors.push(worst)
      expect(Math.abs(pair?.driftPpm ?? 0)).toBeLessThan(5)
    }
    expect(Math.max(...errors)).toBeLessThan(0.01)
  }, 600_000)

  it('丸ごとの相関で「合う」と出る長い2本でも、時計のずれを測って終わりまで合わせる', async () => {
    const T = 5400
    const CAM_START = 20
    const CAM_LEN = 5300
    const RATE = 1 + 40e-6
    const w = world(T, 0, 8, 900)
    const micPath = join(dir, 'long_mic.wav')
    const camPath = join(dir, 'long_cam.m4a')
    writeWav(micPath, record(w, 0, T, 1, 12))
    writeAac(camPath, record(w, CAM_START, CAM_LEN, RATE, 31), dir)
    const report = await syncInProcess([
      input('mic', micPath, 'mic', T),
      input('cam', camPath, 'camera', CAM_LEN)
    ])
    const pair = report.pairs[0]
    const errs = [100, 2700, 5300].map((t) => placementError(report, t, CAM_START, RATE))
    console.log(
      JSON.stringify({ pair, errs: errs.map((e) => Number(e.toFixed(4))) }, (_k, v) =>
        typeof v === 'number' ? Number(v.toFixed(6)) : v
      )
    )
    for (const e of errs) expect(Math.abs(e)).toBeLessThan(0.01)
  }, 600_000)
})

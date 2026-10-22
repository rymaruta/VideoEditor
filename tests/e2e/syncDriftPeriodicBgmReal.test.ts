/**
 * 時計のずれがあり、一定間隔の BGM(0.5 秒おきのキック)が鳴っている2本の同期を、本物の ffmpeg・本物の
 * 同期の Worker で確かめる。
 *
 * 丸ごとの照合が、声の帯域に絞った相関・絞らない相関とも基準を満たさない(時計のずれで山がつぶれる)と、
 * 窓ごとの合わせ直しを確からしさの高いほうの特徴でしか試していなかった。一定間隔の BGM があると、
 * 絞らない相関が周期の山で確からしさだけ高くなり(抜け具合 約1.0 で基準外)、合わせ直しが絞らない
 * 特徴で走って失敗し、合っていた組が「合わない」(offset −739.69)になっていた。
 * - 正しい組(14 分・250ppm・300ppm): 「合う」とし、カメラの頭 30 秒・時計のずれを求める
 * - 同じ周期の BGM を流した別の録音・まばらな物音だけの録音: 「合わない」
 *
 * さらに、時計のずれが大きい・拍が強い・拍の立ち上がりが鋭い・拍がクリック(メトロノーム)だと、相関に並ぶ
 * 拍の周期の山に本当の位置が埋もれ、丸ごとの照合の一番良い位置が両方の特徴とも端の誤った位置
 * (779.5 秒・−733 秒)に出ていた。合わせ直しはその周りしか探さないので「合わない」になっていた
 * (利用者の3時間規模の録画では 30 分・60 分で同じことが起きる。ここでは時計のずれを大きくして 14 分で再現する)。
 * 拍を消した特徴で照らし合わせ直す(correlate の suppressBeat)。拍を消しても、同じ拍の別の録音・
 * メトロノームだけの録音・別の演奏は「合わない」まま
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => ({ cacheDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.cacheDir, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { ffmpegPath, ffprobePath } from '@main/ffmpegService'
import type { SyncInputFile, SyncReport } from '@shared/sync/report'
import { runSyncWorker } from './syncWorkerThread'
import { rng } from '../helpers/movieAudio'

const HAVE_FFMPEG = existsSync(ffmpegPath) && existsSync(ffprobePath)
const SR = 16000
/** 長い音を作る・書く間も、ときどきテストの作業スレッドを空ける(CI の Windows は手元の約7倍遅い) */
const YIELD_EVERY = 1 << 20
const yieldThread = (): Promise<void> => new Promise((r) => setImmediate(r))

interface Burst {
  t: number
  dur: number
  amp: number
  seed: number
}

/** 話し声のような音の粒(0.2〜0.8 秒の雑音の塊が gapMin〜gapMin+gapSpan 秒おき) */
function voices(T: number, seed: number, gapMin = 0.3, gapSpan = 1.7): Burst[] {
  const r = rng(seed)
  const out: Burst[] = []
  for (let t = r(); t < T; t += gapMin + r() * gapSpan)
    out.push({ t, dur: 0.2 + r() * 0.6, amp: 0.05 + r() * 0.25, seed: Math.floor(r() * 1e9) })
  return out
}

/** 拍の音の形。既定は 55Hz のキック(立ち上がり 15ms)。`click` は 1kHz のクリック(メトロノーム) */
interface KickShape {
  attackMs?: number
  click?: boolean
}

/**
 * その機材で録った音。機材の時刻 tc の音は、共通の時刻 start + tc × rate の音。
 * 共通の時刻 kickPhase + 0.5k に 55Hz のキック(kickAmp 0 なら鳴らさない)。雑音は機材ごとに別
 */
async function record(
  bursts: readonly Burst[],
  start: number,
  length: number,
  rate: number,
  noiseSeed: number,
  kickAmp: number,
  kickPhase = 0.1,
  kickShape: KickShape = {}
): Promise<Float32Array> {
  const n = Math.round(length * SR)
  const out = new Float32Array(n)
  const nz = rng(noiseSeed)
  for (let i = 0; i < n; i++) {
    out[i] = (nz() - 0.5) * 0.004
    if (i % YIELD_EVERY === 0) await yieldThread()
  }
  for (const b of bursts) {
    const tc = (b.t - start) / rate
    if (tc < 0 || tc >= length) continue
    const r = rng(b.seed)
    const i0 = Math.round(tc * SR)
    const len = Math.round(b.dur * SR)
    for (let k = 0; k < len && i0 + k < n; k++)
      out[i0 + k] += b.amp * Math.sin((Math.PI * k) / len) * (r() * 2 - 1)
  }
  if (kickAmp > 0) {
    const click = kickShape.click === true
    const klen = Math.round((click ? 0.05 : 0.3) * SR)
    const attack = (kickShape.attackMs ?? 15) / 1000
    const freq = click ? 1000 : 55
    const decay = click ? 0.01 : 0.12
    for (let t = kickPhase; t < start + length * rate + 1; t += 0.5) {
      const tc = (t - start) / rate
      if (tc < 0 || tc >= length) continue
      const i0 = Math.round(tc * SR)
      for (let k = 0; k < klen && i0 + k < n; k++) {
        const env = Math.min(1, k / (attack * SR)) * Math.exp(-k / SR / decay)
        out[i0 + k] += kickAmp * env * Math.sin((2 * Math.PI * freq * k) / SR)
      }
      if (i0 % YIELD_EVERY < klen) await yieldThread()
    }
  }
  return out
}

async function writeWav(path: string, x: Float32Array): Promise<void> {
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
  for (let i = 0; i < x.length; i++) {
    view[i] = Math.round(Math.max(-1, Math.min(1, x[i])) * 32767)
    if (i % YIELD_EVERY === 0) await yieldThread()
  }
  await writeFile(path, buf)
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

const T = 840
const CAM_START = 30
const CAM_LEN = 800
const KICK = 1

const show = (r: SyncReport): string =>
  JSON.stringify({ pairs: r.pairs, placements: r.placements }, (_k, v) =>
    typeof v === 'number' ? Number(v.toFixed(5)) : v
  )

describe.skipIf(!HAVE_FFMPEG)('一定間隔の BGM が鳴る、時計のずれのある2本の同期', () => {
  let dir = ''
  let micPath = ''
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 've-syncbgm-'))
    state.cacheDir = join(dir, 'userdata')
    micPath = join(dir, 'mic.wav')
    await writeWav(micPath, await record(voices(T, 5), 0, T, 1, 11, KICK))
  }, 120_000)
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('時計のずれ 250ppm・300ppm の正しい組を「合う」とし、頭 30 秒・時計のずれを求める', async () => {
    for (const ppm of [250, 300]) {
      const RATE = 1 + ppm * 1e-6
      const camPath = join(dir, `cam${ppm}.wav`)
      await writeWav(camPath, await record(voices(T, 5), CAM_START, CAM_LEN, RATE, 21, KICK))
      const r = await runSyncWorker(
        [input('mic', micPath, 'mic', T), input('cam', camPath, 'camera', CAM_LEN)],
        ffmpegPath,
        state.cacheDir
      )
      rmSync(camPath, { force: true })
      const pair = r.pairs[0]
      expect(pair?.reliable, show(r)).toBe(true)
      const m = r.placements.find((p) => p.id === 'mic')!
      const c = r.placements.find((p) => p.id === 'cam')!
      expect(Math.abs(c.start - m.start - CAM_START), show(r)).toBeLessThan(0.02)
      expect(Math.abs(Math.abs(pair.driftPpm ?? 0) - ppm), show(r)).toBeLessThan(20)
    }
  }, 300_000)

  it('同じ周期の BGM を流した別の録音・まばらな物音だけの録音は「合わない」', async () => {
    const cases: [string, Float32Array][] = [
      ['other_bgm.wav', await record(voices(CAM_LEN, 77), 0, CAM_LEN, 1 + 250e-6, 31, KICK, 0.27)],
      ['sparse.wav', await record(voices(CAM_LEN, 78, 5, 10), 0, CAM_LEN, 1, 32, 0)]
    ]
    for (const [name, x] of cases) {
      const p = join(dir, name)
      await writeWav(p, x)
      const r = await runSyncWorker(
        [input('mic', micPath, 'mic', T), input('cam', p, 'camera', CAM_LEN)],
        ffmpegPath,
        state.cacheDir
      )
      rmSync(p, { force: true })
      expect(
        r.pairs.every((x) => !x.reliable),
        `${name}: ${show(r)}`
      ).toBe(true)
    }
  }, 300_000)
  /** 正しい組を照らし合わせ、「合う」・カメラの頭 30 秒(10ms 以内)・時計のずれを確かめる */
  const expectMatched = async (
    name: string,
    ppm: number,
    kickAmp: number,
    shape: KickShape
  ): Promise<void> => {
    const p = join(dir, `${name}.wav`)
    // マイクにも同じ形の拍を入れる(同じ会場の BGM)。既定の形なら beforeAll で作ったものを使う
    const own = kickAmp !== KICK || shape.attackMs !== undefined || shape.click === true
    const mic = own ? join(dir, `${name}_mic.wav`) : micPath
    if (own) await writeWav(mic, await record(voices(T, 5), 0, T, 1, 11, kickAmp, 0.1, shape))
    await writeWav(
      p,
      await record(voices(T, 5), CAM_START, CAM_LEN, 1 + ppm * 1e-6, 21, kickAmp, 0.1, shape)
    )
    const r = await runSyncWorker(
      [input('mic', mic, 'mic', T), input('cam', p, 'camera', CAM_LEN)],
      ffmpegPath,
      state.cacheDir
    )
    rmSync(p, { force: true })
    if (own) rmSync(mic, { force: true })
    const pair = r.pairs[0]
    expect(pair?.reliable, `${name}: ${show(r)}`).toBe(true)
    const m = r.placements.find((x) => x.id === 'mic')!
    const c = r.placements.find((x) => x.id === 'cam')!
    expect(Math.abs(c.start - m.start - CAM_START), `${name}: ${show(r)}`).toBeLessThan(0.01)
    expect(Math.abs(Math.abs(pair.driftPpm ?? 0) - ppm), `${name}: ${show(r)}`).toBeLessThan(20)
  }

  it('時計のずれが大きい・拍が強い・立ち上がりが鋭い・クリックの拍でも、正しい組を「合う」とする', async () => {
    await expectMatched('ppm500', 500, KICK, {})
    await expectMatched('loud_sharp', 300, 3, { attackMs: 2 })
    await expectMatched('metronome', 300, 0.3, { click: true })
  }, 300_000)

  it('拍を消して照らし合わせ直しても、同じ拍の別の録音・メトロノームだけ・別の演奏は「合わない」', async () => {
    const cases: [string, () => Promise<Float32Array>][] = [
      // 同じ拍の BGM・別の話し声(拍を強く・鋭く、時計のずれ 500ppm、位相違い)
      [
        'other_bgm_sharp.wav',
        () => record(voices(CAM_LEN, 77), 0, CAM_LEN, 1 + 500e-6, 31, 3, 0.33, { attackMs: 2 })
      ],
      // 同じ周期のクリックだけ(別の部屋のメトロノーム)
      [
        'metronome_only.wav',
        () => record([], 0, CAM_LEN, 1 + 300e-6, 33, 0.3, 0.4, { click: true })
      ],
      // 拍だけ同じで、まばらな物音(別の演奏の録音で、客席の物音だけが入っている)
      [
        'other_perf_sparse.wav',
        () => record(voices(CAM_LEN, 79, 3, 6), 0, CAM_LEN, 1 + 300e-6, 34, KICK, 0.3)
      ]
    ]
    for (const [name, make] of cases) {
      const p = join(dir, name)
      await writeWav(p, await make())
      const r = await runSyncWorker(
        [input('mic', micPath, 'mic', T), input('cam', p, 'camera', CAM_LEN)],
        ffmpegPath,
        state.cacheDir
      )
      rmSync(p, { force: true })
      expect(
        r.pairs.every((x) => !x.reliable),
        `${name}: ${show(r)}`
      ).toBe(true)
    }
  }, 300_000)
})

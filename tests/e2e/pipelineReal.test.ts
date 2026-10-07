/**
 * 自動編集の流れ(pipelineStore.runPipeline)を、本物の ffmpeg と本物の素材ファイルで端から端まで回す受け入れテスト。
 *
 * - 素材は毎回ここで作る(カメラ2台 + ピンマイク2本、2分半)。どの機材がいつ録り始めたか・
 *   どこで誰が何を言ったか(正解)が分かっているので、同期・並べ方・カット・テロップを正解と比べられる。
 * - main プロセスの関数(取り込みの scanFootage・同期の syncWorker・音の大きさの cachedEnvelope・
 *   probeMedia・番組素材の scanShowKit)は本物を呼ぶ。同期は Worker を立てずに、同じスレッドで syncWorker を動かす。
 * - 音声認識・AI(構成・演出テロップ)・顔・色・ノイズ除去・笑いの検出は、正解から作った決まった答えを返す。
 *
 * ffmpeg(node_modules/ffmpeg-static)か ffprobe が無ければ飛ばす。
 * 作った素材を残して見るには `E2E_PIPELINE_DIR=<フォルダ>` を付けて走らせる(結果の数字も report-*.json に書く)。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
  return { cacheDir: '' }
})

vi.mock('electron', () => ({
  app: { getPath: () => state.cacheDir, isPackaged: false, getAppPath: () => process.cwd() }
}))
// footageService は同期を Worker で立てる(ここでは使わない)。読み込むと syncWorker が走り出すので差し替える
vi.mock('@main/syncWorker?modulePath', () => ({ default: '' }))

import { ffmpegPath, ffprobePath, probeMedia } from '@main/ffmpegService'
import { scanFootage } from '@main/footageService'
import { cachedEnvelope } from '@main/audioPcm'
import { scanShowKit } from '@main/showKitService'
import { usePipelineStore } from '@renderer/store/pipelineStore'
import { getTotalDuration, useProjectStore } from '@renderer/store/projectStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import type { SyncInputFile, SyncReport, SyncWorkerMessage } from '@shared/sync/report'
import type { AsrJob, AsrJobResult } from '@shared/transcript'
import type { Project } from '@shared/types'
import type { SourceKind } from '@shared/ingest/classify'

const HAVE_FFMPEG = existsSync(ffmpegPath) && existsSync(ffprobePath)
const FRAME = 1 / 30
const FS = 48000
const STEM_FS = 24000
const T0 = -2
const T1 = 152

// ---------------------------------------------------------------- 正解(台本)

interface Word {
  speaker: number
  text: string
  start: number
  end: number
  f0: number
}
interface Utterance {
  speaker: number
  words: Word[]
  start: number
  end: number
}
interface SharedEvent {
  kind: 'clap' | 'beep' | 'noise'
  at: number
  len: number
}

/** 固定種の乱数 */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}
function hashNoise(i: number, seed: number): number {
  let x = (Math.imul(i | 0, 374761393) + Math.imul(seed, 668265263)) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  x ^= x >>> 16
  return ((x >>> 0) / 4294967296) * 2 - 1
}

const VOCAB = [
  'こんにちは',
  '今日',
  'とても',
  'いい',
  '天気',
  'ですね',
  'この',
  'お店',
  'ラーメン',
  'おいしい',
  '有名',
  'らしい',
  '行って',
  'みましょう',
  '本当',
  'すごい',
  '並んで',
  'ますよ',
  '駅前',
  '名物'
]

const SPEAKER_F0 = [0, 125, 215, 170] // 1: 田中(マイク1) 2: 佐藤(マイク2) 3: 合わないマイクの人

/** 台本: 3つの話のまとまり。間に長い無音(60〜68 秒・106〜114 秒)を置く */
function makeScript(): { utterances: Utterance[]; events: SharedEvent[] } {
  const r = rng(20261005)
  const utterances: Utterance[] = []
  const events: SharedEvent[] = [
    { kind: 'noise', at: 2.0, len: 0.4 },
    { kind: 'clap', at: 5.0, len: 0.12 },
    { kind: 'clap', at: 5.6, len: 0.12 },
    { kind: 'clap', at: 6.2, len: 0.12 },
    { kind: 'clap', at: 68.5, len: 0.12 },
    { kind: 'clap', at: 69.1, len: 0.12 },
    { kind: 'noise', at: 115.0, len: 0.4 },
    { kind: 'clap', at: 142.0, len: 0.12 },
    { kind: 'clap', at: 142.7, len: 0.12 }
  ]
  const beepsAt = [30, 90, 128]
  const sections: [number, number][] = [
    [8, 58],
    [71, 104],
    [117, 140]
  ]
  let speaker = 1
  for (const [from, to] of sections) {
    let t = from
    while (t < to - 2) {
      // ビープ(全員に聞こえる)を、発話の切れ目に挟む
      const beep = beepsAt.find((b) => b >= t && b < t + 6)
      if (beep !== undefined && beep - t < 1.0) {
        events.push({ kind: 'beep', at: t + 0.3, len: 0.25 })
        t += 1.2
        continue
      }
      const words: Word[] = []
      const target = 1.5 + r() * 3
      let w = t
      while (w - t < target) {
        const len = 0.22 + r() * 0.3
        const text = VOCAB[Math.floor(r() * VOCAB.length)]
        words.push({
          speaker,
          text,
          start: w,
          end: w + len,
          f0: SPEAKER_F0[speaker] * (0.9 + r() * 0.2)
        })
        w += len + 0.06 + r() * 0.08
      }
      const end = words[words.length - 1].end
      utterances.push({ speaker, words, start: t, end })
      // たまに相手が食い気味に返す(短い重なり)
      const overlapNext = r() < 0.12
      t = overlapNext ? end - 0.35 : end + 0.5 + r() * 0.9
      speaker = speaker === 1 ? 2 : 1
    }
  }
  return { utterances, events: events.sort((a, b) => a.at - b.at) }
}

/** 合わないマイク(別の場所で録った人)の台本 */
function makeStrangerScript(): { utterances: Utterance[]; events: SharedEvent[] } {
  const r = rng(77)
  const utterances: Utterance[] = []
  const events: SharedEvent[] = []
  let t = 3
  while (t < 140) {
    const words: Word[] = []
    let w = t
    const target = 1 + r() * 3
    while (w - t < target) {
      const len = 0.2 + r() * 0.3
      words.push({ speaker: 3, text: 'ほか', start: w, end: w + len, f0: 170 * (0.9 + r() * 0.2) })
      w += len + 0.08
    }
    utterances.push({ speaker: 3, words, start: t, end: words[words.length - 1].end })
    if (r() < 0.3) events.push({ kind: 'clap', at: w + 0.3, len: 0.12 })
    t = w + 1 + r() * 3
  }
  return { utterances, events }
}

// ---------------------------------------------------------------- 音を作る

/** 共通の時間軸(T0〜T1)の上で鳴る音(話者ごと・全員に聞こえる音) */
function renderStems(
  script: { utterances: Utterance[]; events: SharedEvent[] },
  maxSpeaker: number
): { speakers: Float32Array[]; shared: Float32Array } {
  const n = Math.ceil((T1 - T0) * STEM_FS)
  const speakers: Float32Array[] = []
  for (let s = 0; s <= maxSpeaker; s++) speakers.push(new Float32Array(n))
  const shared = new Float32Array(n)
  for (const u of script.utterances) {
    for (const w of u.words) {
      const out = speakers[w.speaker]
      const a = Math.floor((w.start - T0) * STEM_FS)
      const b = Math.ceil((w.end - T0) * STEM_FS)
      const len = w.end - w.start
      const formant = 500 + (hashNoise(a, 9) + 1) * 400
      for (let i = a; i < b; i++) {
        const tau = (i - a) / STEM_FS
        const env =
          Math.min(1, tau / 0.025, (len - tau) / 0.04) *
          (0.65 + 0.35 * Math.cos(2 * Math.PI * 5 * tau))
        if (env <= 0) continue
        const f = w.f0 * (1 + 0.05 * (tau / len))
        const ph = 2 * Math.PI * f * tau
        let v = 0
        for (let k = 1; k <= 10; k++) {
          const fk = f * k
          const g = 1 / (1 + ((fk - formant) / 400) ** 2) + 0.3 / k
          v += g * Math.sin(k * ph)
        }
        out[i] += 0.35 * env * v
      }
    }
  }
  for (const e of script.events) {
    const a = Math.floor((e.at - T0) * STEM_FS)
    const b = Math.ceil((e.at + e.len - T0) * STEM_FS)
    for (let i = a; i < b; i++) {
      const tau = (i - a) / STEM_FS
      let v = 0
      if (e.kind === 'clap') v = hashNoise(i, 3) * Math.exp(-tau / 0.015)
      else if (e.kind === 'beep')
        v =
          0.6 * Math.sin(2 * Math.PI * 1000 * tau) * Math.min(1, tau / 0.005, (e.len - tau) / 0.005)
      else v = 0.5 * hashNoise(i, 5) * Math.min(1, tau / 0.02, (e.len - tau) / 0.02)
      shared[i] += v
    }
  }
  return { speakers, shared }
}

interface DeviceMix {
  /** 話者ごとの大きさ(添字は話者番号) */
  speech: number[]
  shared: number
  floor: number
  seed: number
}

/** 1本のファイルの音。ファイルの頭が共通の時刻 start、ファイルの時計は共通の時計の rate 倍で進む */
function renderFile(
  stems: { speakers: Float32Array[]; shared: Float32Array },
  mix: DeviceMix,
  start: number,
  rate: number,
  duration: number
): Float32Array {
  const n = Math.round(duration * FS)
  const out = new Float32Array(n)
  const sample = (arr: Float32Array, x: number): number => {
    const i = Math.floor(x)
    if (i < 0 || i + 1 >= arr.length) return 0
    const f = x - i
    return arr[i] * (1 - f) + arr[i + 1] * f
  }
  for (let i = 0; i < n; i++) {
    const T = start + i / FS / rate
    const x = (T - T0) * STEM_FS
    let v = mix.shared * sample(stems.shared, x) + mix.floor * hashNoise(i, mix.seed)
    for (let s = 1; s < mix.speech.length; s++)
      if (mix.speech[s]) v += mix.speech[s] * sample(stems.speakers[s], x)
    out[i] = Math.max(-1, Math.min(1, v))
  }
  return out
}

function writeWav(path: string, samples: Float32Array): void {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples.length * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(FS, 24)
  buf.writeUInt32LE(FS * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++)
    buf.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2)
  writeFileSync(path, buf)
}

function writeCamera(path: string, wav: string | null, duration: number, createdAt: string): void {
  const args = [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=160x90:r=30`,
    ...(wav ? ['-i', wav] : []),
    '-t',
    duration.toFixed(3),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '45',
    '-pix_fmt',
    'yuv420p',
    ...(wav ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
    '-metadata',
    `creation_time=${createdAt}`,
    path
  ]
  execFileSync(ffmpegPath, args)
}

// ---------------------------------------------------------------- 収録(機材と正解の位置)

interface TruthFile {
  rel: string
  device: string
  kind: SourceKind
  /** 共通の時刻(カメラAの時計)で、ファイルの頭 */
  start: number
  /** ファイルの時計 / 共通の時計 */
  rate: number
  duration: number
  /** このマイクを付けた話者(マイクだけ) */
  wearer?: number
  hasAudio: boolean
}

interface Shoot {
  root: string
  files: TruthFile[]
  script: { utterances: Utterance[]; events: SharedEvent[] }
  /** 正解の発話のうち、合うはずのマイクで録っている人(マイクが無ければ全員) */
  speakers: number[]
}

const BASE_TIME = Date.parse('2026-09-01T10:00:00Z')
const iso = (offsetSec: number): string =>
  new Date(BASE_TIME + Math.floor(offsetSec) * 1000).toISOString()

/** 全部の機材のファイルを1回だけ作り、場合ごとのフォルダには固いリンクで置く */
interface Library {
  lib: string
  truth: Record<string, TruthFile>
  script: { utterances: Utterance[]; events: SharedEvent[] }
}

function makeLibrary(dir: string): Library {
  const script = makeScript()
  const stranger = makeStrangerScript()
  const stems = renderStems(script, 2)
  const strangerStems = renderStems(stranger, 3)
  const lib = join(dir, 'library')
  mkdirSync(lib, { recursive: true })
  const truth: Record<string, TruthFile> = {}
  const camMix = (s1: number, s2: number, seed: number): DeviceMix => ({
    speech: [0, s1, s2],
    shared: 0.5,
    floor: 0.003,
    seed
  })
  const cam = (
    name: string,
    device: string,
    start: number,
    duration: number,
    mix: DeviceMix,
    audio: boolean
  ): void => {
    const wav = join(lib, `${name}.cam.wav`)
    if (audio) writeWav(wav, renderFile(stems, mix, start, 1, duration))
    writeCamera(join(lib, `${name}.MP4`), audio ? wav : null, duration, iso(start))
    if (audio) rmSync(wav)
    truth[name] = {
      rel: `${name}.MP4`,
      device,
      kind: 'camera',
      start,
      rate: 1,
      duration,
      hasAudio: audio
    }
  }
  cam('A001', 'camA', 0, 150, camMix(0.15, 0.15, 11), true)
  // カメラB: カメラAより 3.217 秒遅れて回し始め、68 秒で分割された2本目に続く
  cam('B001', 'camB', 3.217, 68, camMix(0.08, 0.2, 12), true)
  cam('B002', 'camB', 3.217 + 68, 74, camMix(0.08, 0.2, 13), true)
  cam('B001_mute', 'camB', 3.217, 68, camMix(0, 0, 0), false)
  cam('B002_mute', 'camB', 3.217 + 68, 74, camMix(0, 0, 0), false)
  const mic = (
    name: string,
    device: string,
    start: number,
    rate: number,
    duration: number,
    mix: DeviceMix,
    wearer: number,
    from = stems
  ): void => {
    writeWav(join(lib, `${name}.WAV`), renderFile(from, mix, start, rate, duration))
    truth[name] = {
      rel: `${name}.WAV`,
      device,
      kind: 'mic',
      start,
      rate,
      duration,
      wearer,
      hasAudio: true
    }
  }
  // マイク1: カメラAより 1.5 秒早く回した。マイク2: 0.733 秒遅れ、時計が 200ppm 速い
  mic(
    'MIC1',
    'mic1',
    -1.5,
    1,
    153,
    { speech: [0, 0.5, 0.05], shared: 0.3, floor: 0.001, seed: 21 },
    1
  )
  mic(
    'MIC2',
    'mic2',
    0.733,
    1.0002,
    148,
    { speech: [0, 0.05, 0.5], shared: 0.3, floor: 0.001, seed: 22 },
    2
  )
  // 合わないマイク: 別の場所で、別の人の声とほかの音だけを録った
  mic(
    'MIC3',
    'mic3',
    0,
    1,
    145,
    { speech: [0, 0, 0, 0.5], shared: 0.3, floor: 0.001, seed: 23 },
    3,
    strangerStems
  )
  return { lib, truth, script }
}

function makeShoot(
  library: Library,
  dir: string,
  name: string,
  layout: Record<string, string[]>
): Shoot {
  const root = join(dir, name)
  rmSync(root, { recursive: true, force: true })
  const files: TruthFile[] = []
  for (const [folder, names] of Object.entries(layout)) {
    mkdirSync(join(root, folder), { recursive: true })
    for (const n of names) {
      const t = library.truth[n]
      // 置く名前は機材ごとに同じ形(B001_mute → B001.MP4)
      const fileName = t.rel.replace('_mute', '')
      const rel = `${folder}/${fileName}`
      linkSync(join(library.lib, t.rel), join(root, rel))
      files.push({ ...t, rel })
    }
  }
  const wearers = files.filter((f) => f.wearer !== undefined && f.wearer < 3).map((f) => f.wearer!)
  return {
    root,
    files,
    script: library.script,
    speakers: wearers.length > 0 ? [...new Set(wearers)] : [1, 2]
  }
}

// ---------------------------------------------------------------- アプリの main 側(本物 + 決まった答え)

/** syncWorker を同じスレッドで走らせる(Worker と同じ入力・同じ出力) */
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

interface Calls {
  asrJobs: AsrJob[]
  llm: number
  unknown: string[]
}

function installApi(shoot: Shoot, calls: Calls): void {
  const byPath = new Map(shoot.files.map((f) => [join(shoot.root, f.rel), f]))
  const words = shoot.script.utterances.flatMap((u) => u.words)
  const asr = (job: AsrJob): AsrJobResult => {
    calls.asrJobs.push(job)
    const f = byPath.get(job.path)
    if (!f) return { id: job.id, text: '', words: [] }
    const from = f.start + job.start / f.rate
    const to = f.start + job.end / f.rate
    const heard = words.filter(
      (w) =>
        (f.wearer === undefined ? shoot.speakers.includes(w.speaker) : w.speaker === f.wearer) &&
        (w.start + w.end) / 2 >= from &&
        (w.start + w.end) / 2 < to
    )
    // 1本の音から聞き取ったので、言葉の時刻は重ならない(声が重なった所は、前の言葉を次の頭で切る)
    heard.sort((a, b) => a.start - b.start)
    return {
      id: job.id,
      text: heard.map((w) => w.text).join(''),
      words: heard.map((w, i) => ({
        text: w.text,
        start: (w.start - f.start) * f.rate,
        end: (Math.min(w.end, heard[i + 1]?.start ?? Infinity) - f.start) * f.rate
      }))
    }
  }
  const noop = (): (() => void) => () => {}
  const api: Record<string, unknown> = {
    footageScan: (root: string, options?: { tracks?: boolean }) =>
      scanFootage(root, () => {}, options),
    onFootageScanProgress: noop,
    syncRun: (files: SyncInputFile[]) => syncInProcess(files),
    onSyncProgress: noop,
    probeMedia: (p: string) => probeMedia(p),
    generateThumbnail: async () => '',
    libraryRemember: async () => ({}),
    footageEnvelopes: (paths: string[]) =>
      Promise.all(
        paths.map((path) => {
          const st = statSync(path)
          return cachedEnvelope(ffmpegPath, state.cacheDir, {
            path,
            size: st.size,
            mtimeMs: st.mtimeMs
          })
        })
      ),
    onAsrProgress: noop,
    asrRun: async (jobs: AsrJob[]) => jobs.map(asr),
    onDenoiseProgress: noop,
    denoiseRun: async (sources: string[]) =>
      sources.map((source) => ({ source, error: 'テストでは除かない' })),
    onEventsProgress: noop,
    // 笑い(テストの決まった答え): 共通の時刻 40〜41 秒
    eventsRun: async () => [{ start: 40, end: 41, laugh: 0.95, cheer: 0 }],
    onFramesProgress: noop,
    framesRgb: async (requests: unknown[]) => requests.map(() => null),
    onFaceProgress: noop,
    faceDetect: async (requests: unknown[]) => requests.map(() => []),
    onLlmProgress: noop,
    llmRun: async (requests: { schema: Record<string, unknown> }[]) => {
      calls.llm += requests.length
      return requests.map((rq) => {
        const props = (rq.schema.properties ?? {}) as Record<string, unknown>
        if ('effects' in props) {
          const ids = ((props.effects as { items: { properties: { after: { enum: string[] } } } })
            .items.properties.after.enum ?? []) as string[]
          return {
            effects: ids.slice(2, 3).map((after) => ({
              after,
              kind: 'tsukkomi',
              reason: 'テスト',
              text: 'うまそう!',
              confidence: 0.95
            }))
          }
        }
        return Object.fromEntries(
          Object.keys(props).map((id, i) => [
            id,
            {
              title: `場面${i + 1}`,
              reason: 'テスト',
              kind: i === 0 ? 'highlight' : 'normal',
              score: i === 0 ? 85 : 60,
              mood: '楽しい'
            }
          ])
        )
      })
    },
    showKitScan: (root: string) => scanShowKit(root),
    getEnvApiKeys: async () => ({}),
    onMenuCommand: noop,
    updateMenu: async () => {},
    setBusyState: () => {},
    notifyDone: () => {}
  }
  const proxy = new Proxy(api, {
    get(target, key: string) {
      if (key in target) return target[key]
      calls.unknown.push(key)
      return key.startsWith('on') ? noop : async () => undefined
    }
  })
  ;(globalThis as unknown as { window: unknown }).window = {
    api: proxy,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {}
  }
}

function makeKit(dir: string): string {
  const kit = join(dir, 'kit')
  for (const sub of ['SE/ツッコミ', 'SE/場面転換', 'BGM/楽しい', 'BGM/穏やか', 'CG/おいしい'])
    mkdirSync(join(kit, sub), { recursive: true })
  const tone = (sec: number, f: number): Float32Array =>
    Float32Array.from(
      { length: Math.round(sec * FS) },
      (_, i) => 0.2 * Math.sin((2 * Math.PI * f * i) / FS)
    )
  writeWav(join(kit, 'SE/ツッコミ/hit.wav'), tone(0.5, 880))
  writeWav(join(kit, 'SE/場面転換/swoosh.wav'), tone(0.8, 440))
  writeWav(join(kit, 'BGM/楽しい/fun.wav'), tone(20, 330))
  writeWav(join(kit, 'BGM/穏やか/calm.wav'), tone(20, 220))
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=64x36',
    '-frames:v',
    '1',
    join(kit, 'CG/おいしい/oishii.png')
  ])
  return kit
}

// ---------------------------------------------------------------- 正解と比べる

interface Measured {
  scenario: string
  steps: Record<string, string>
  sources: { name: string; kind: string; files: string[] }[]
  offsets: {
    file: string
    expected: number
    got: number | null
    errMs: number | null
    method?: string
  }[]
  driftEndErrMs: Record<string, number>
  layoutEventErrMs: number
  cutAlignErrMs: number
  missingWords: number
  totalWords: number
  wordsCut: { text: string; start: number; end: number; boundary: number }[]
  silenceKept: Record<string, number>
  telop: {
    count: number
    maxEarlyMs: number
    maxEarlyAtCutMs: number
    maxLateEndMs: number
    maxEarlyEndMs: number
  }
  speakers: {
    gtUtterances: number
    gtOverlaps: number
    utterances: number
    flaggedOverlap: number
    flaggedWithoutOverlap: number
    wordsTranscribed: number
    wrongSpeaker: number
    turnLateStartMs: number
    turnEarlyEndMs: number
  }
  durations: Record<string, number>
  nan: string[]
  violations: string[]
}

function findNaN(value: unknown, path: string, out: string[], seen = new Set<unknown>()): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path}=${value}`)
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (ArrayBuffer.isView(value)) return
  if (Array.isArray(value)) value.forEach((v, i) => findNaN(v, `${path}[${i}]`, out, seen))
  else for (const [k, v] of Object.entries(value)) findNaN(v, `${path}.${k}`, out, seen)
}

/** 本編・PiP・音声のクリップ(タイムラインの秒)から、その瞬間に映っている/鳴っている「正解の共通時刻」 */
interface TimedClip {
  assetId: string
  timelineStart: number
  timelineEnd: number
  inPoint: number
  speed: number
}

function mainTimed(project: Project): TimedClip[] {
  let t = 0
  return project.clips.map((c) => {
    const len = (c.outPoint - c.inPoint) / (c.speed || 1)
    const out = {
      assetId: c.assetId,
      timelineStart: t,
      timelineEnd: t + len,
      inPoint: c.inPoint,
      speed: c.speed || 1
    }
    t += len
    return out
  })
}

function trackTimed(
  clips: { assetId: string; startTime: number; inPoint: number; outPoint: number; speed?: number }[]
): TimedClip[] {
  return clips.map((c) => ({
    assetId: c.assetId,
    timelineStart: c.startTime,
    timelineEnd: c.startTime + (c.outPoint - c.inPoint) / (c.speed || 1),
    inPoint: c.inPoint,
    speed: c.speed || 1
  }))
}

function verify(
  name: string,
  shoot: Shoot,
  layoutSnapshot: Project | null,
  calls: Calls
): Measured {
  const pipe = usePipelineStore.getState()
  const project = useProjectStore.getState().project
  const v: string[] = []
  const m: Measured = {
    scenario: name,
    steps: Object.fromEntries(
      Object.entries(pipe.steps).map(([k, s]) => [k, `${s.state}${s.note ? ` (${s.note})` : ''}`])
    ),
    sources: pipe.sources.map((s) => ({
      name: s.name,
      kind: s.kind,
      files: s.files.map((f) => f.relativePath)
    })),
    offsets: [],
    driftEndErrMs: {},
    layoutEventErrMs: 0,
    cutAlignErrMs: 0,
    missingWords: 0,
    totalWords: 0,
    wordsCut: [],
    silenceKept: {},
    telop: { count: 0, maxEarlyMs: 0, maxEarlyAtCutMs: 0, maxLateEndMs: 0, maxEarlyEndMs: 0 },
    speakers: {
      gtUtterances: 0,
      gtOverlaps: 0,
      utterances: 0,
      flaggedOverlap: 0,
      flaggedWithoutOverlap: 0,
      wordsTranscribed: 0,
      wrongSpeaker: 0,
      turnLateStartMs: 0,
      turnEarlyEndMs: 0
    },
    durations: {},
    nan: [],
    violations: v
  }
  const truthOfAsset = new Map<string, TruthFile>()
  for (const a of project.assets) {
    const t = shoot.files.find((f) => join(shoot.root, f.rel) === a.filePath)
    if (t) truthOfAsset.set(a.id, t)
  }
  const info = project.multicam
  if (!info) {
    v.push('project.multicam がありません')
    return m
  }
  /** 正解: ファイルの時刻 → 共通の時刻 */
  const trueCommon = (assetId: string, fileTime: number): number => {
    const t = truthOfAsset.get(assetId)!
    return t.start + fileTime / t.rate
  }

  // --- 振り分け
  const devices = new Map<string, string[]>()
  for (const s of pipe.sources)
    for (const f of s.files) {
      const t = shoot.files.find((x) => x.rel === f.relativePath)!
      devices.set(t.device, [...(devices.get(t.device) ?? []), s.id])
      if ((s.kind as string) !== t.kind)
        v.push(`振り分け: ${f.relativePath} は ${t.kind} のはずが ${s.kind}`)
    }
  for (const [device, ids] of devices)
    if (new Set(ids).size !== 1)
      v.push(`振り分け: ${device} のファイルが別々の系統になった (${[...new Set(ids)].join(', ')})`)
  if (new Set([...devices.values()].map((ids) => ids[0])).size !== devices.size)
    v.push('振り分け: 別の機材が同じ系統にまとめられた')

  // --- 同期の位置(基準カメラ A001 からの相対)
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const anchorAsset = project.assets.find((a) => truthOfAsset.get(a.id)?.rel.endsWith('A001.MP4'))
  const anchorPlaced = anchorAsset ? fileOf.get(anchorAsset.id) : undefined
  for (const a of project.assets) {
    const t = truthOfAsset.get(a.id)
    if (!t) continue
    const placed = fileOf.get(a.id)
    const placement = pipe.report?.placements.find((p) => p.id === a.filePath)
    const expectSynced = t.device !== 'mic3' && t.hasAudio
    if (!placed || !anchorPlaced) {
      m.offsets.push({
        file: t.rel,
        expected: t.start,
        got: null,
        errMs: null,
        method: placement?.method
      })
      if (expectSynced) v.push(`同期: ${t.rel} が並ばなかった (method=${placement?.method})`)
      continue
    }
    const got = placed.start - anchorPlaced.start
    const err = got - t.start
    m.offsets.push({
      file: t.rel,
      expected: t.start,
      got,
      errMs: err * 1000,
      method: placement?.method
    })
    if (!expectSynced)
      v.push(
        `同期: ${t.rel} は合わないはずなのに ${placement?.method} で ${got.toFixed(3)} 秒に置かれた`
      )
    else if (Math.abs(err) > FRAME)
      v.push(`同期: ${t.rel} の頭が ${(err * 1000).toFixed(1)}ms ずれた`)
    // 時計のずれ: ファイルの終わりでの位置の誤差
    const endFile = t.duration
    const gotEnd = placed.start + endFile / placed.rate - anchorPlaced.start
    const trueEnd = t.start + endFile / t.rate
    m.driftEndErrMs[t.rel] = (gotEnd - trueEnd) * 1000
    if (expectSynced && Math.abs(gotEnd - trueEnd) > FRAME)
      v.push(
        `同期: ${t.rel} の終わりが ${((gotEnd - trueEnd) * 1000).toFixed(1)}ms ずれた(時計のずれ)`
      )
  }

  // --- 並べた直後のタイムライン: 同じ音の出来事が、どの機材でも同じタイムラインの時刻にあるか
  if (layoutSnapshot) {
    const tracks: { name: string; clips: TimedClip[] }[] = [
      { name: 'V1', clips: mainTimed(layoutSnapshot) },
      ...layoutSnapshot.videoOverlayTracks
        .filter((t) => t.multicamSourceId)
        .map((t) => ({ name: t.name, clips: trackTimed(t.clips) })),
      ...layoutSnapshot.audioTracks
        .filter((t) => t.multicamSourceId)
        .map((t) => ({ name: t.name, clips: trackTimed(t.clips) }))
    ]
    let worst = 0
    for (const e of shoot.script.events) {
      const at: { name: string; t: number }[] = []
      for (const tr of tracks)
        for (const c of tr.clips) {
          const truth = truthOfAsset.get(c.assetId)
          if (!truth) continue
          const fileTime = (e.at - truth.start) * truth.rate
          const t = c.timelineStart + (fileTime - c.inPoint) / c.speed
          if (t >= c.timelineStart - 1e-6 && t < c.timelineEnd) at.push({ name: tr.name, t })
        }
      const v1 = at.find((x) => x.name === 'V1')
      if (!v1) continue
      for (const x of at) {
        const d = Math.abs(x.t - v1.t)
        worst = Math.max(worst, d)
        if (d > FRAME)
          v.push(
            `並べ方: ${e.kind}@${e.at} が ${x.name} で V1 から ${(d * 1000).toFixed(1)}ms ずれた`
          )
      }
    }
    m.layoutEventErrMs = worst * 1000
  } else v.push('並べた直後のタイムラインを取れなかった')

  // --- 仮編集の後: 本編の画と、マイク・周りの音がそろっているか
  const main = mainTimed(project)
  const total = getTotalDuration(project)
  m.durations = {
    timeline: total,
    roughCut: pipe.roughCut?.duration ?? NaN,
    mainSum: main.reduce((s, c) => s + c.timelineEnd - c.timelineStart, 0),
    spansSum: pipe.lastSpans.reduce((s, x) => s + x.end - x.start, 0)
  }
  if (Math.abs(m.durations.mainSum - m.durations.roughCut) > 1e-3)
    v.push(`長さ: 本編 ${m.durations.mainSum} と仮編集 ${m.durations.roughCut} が違う`)
  if (Math.abs(m.durations.spansSum - m.durations.roughCut) > 1e-3)
    v.push(`長さ: 区間の合計 ${m.durations.spansSum} と仮編集 ${m.durations.roughCut} が違う`)
  let worstAlign = 0
  for (const tr of project.audioTracks.filter((t) => t.multicamSourceId)) {
    for (const c of trackTimed(tr.clips)) {
      if (c.timelineEnd > total + 1e-3)
        v.push(
          `長さ: ${tr.name} のクリップが本編の終わり ${total.toFixed(3)} を越えて ${c.timelineEnd.toFixed(3)} まで`
        )
      for (let k = 0; k <= 4; k++) {
        const t = c.timelineStart + ((c.timelineEnd - c.timelineStart) * (k + 0.5)) / 5.0001
        const mc = main.find((x) => t >= x.timelineStart && t < x.timelineEnd)
        if (!mc) continue
        const tv = trueCommon(mc.assetId, mc.inPoint + (t - mc.timelineStart) * mc.speed)
        const ta = trueCommon(c.assetId, c.inPoint + (t - c.timelineStart) * c.speed)
        const d = Math.abs(tv - ta)
        worstAlign = Math.max(worstAlign, d)
        if (d > FRAME)
          v.push(
            `仮編集: ${tr.name} がタイムライン ${t.toFixed(2)} 秒で画から ${(d * 1000).toFixed(1)}ms ずれた`
          )
      }
    }
  }
  m.cutAlignErrMs = worstAlign * 1000
  // 本編の時刻 → 正解の共通時刻
  // 頭は [頭, 終わり) で、終わりは (頭, 終わり] で探す(切れ目ちょうどの時刻を前後どちらのクリップで読むか)
  const commonAt = (t: number, side: 'start' | 'end' = 'start'): number | null => {
    const mc = main.find((x) =>
      side === 'start'
        ? t >= x.timelineStart - 1e-6 && t < x.timelineEnd - 1e-6
        : t > x.timelineStart + 1e-6 && t <= x.timelineEnd + 1e-6
    )
    return mc ? trueCommon(mc.assetId, mc.inPoint + (t - mc.timelineStart) * mc.speed) : null
  }
  // 本編で、正解の時刻の範囲 [a, b) が使われているか(どれだけ使われているか)
  const keptRanges: [number, number][] = []
  for (const c of main) {
    const a = trueCommon(c.assetId, c.inPoint)
    const b = trueCommon(c.assetId, c.inPoint + (c.timelineEnd - c.timelineStart) * c.speed)
    const last = keptRanges[keptRanges.length - 1]
    if (last && Math.abs(last[1] - a) < 0.002) last[1] = b
    else keptRanges.push([a, b])
  }
  const keptWithin = (a: number, b: number): number =>
    keptRanges.reduce((s, [x, y]) => s + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0)

  // --- 話した言葉は残っているか・言葉の途中で切っていないか
  const words = shoot.script.utterances
    .filter((u) => shoot.speakers.includes(u.speaker))
    .flatMap((u) => u.words)
  m.totalWords = words.length
  for (const w of words) {
    const kept = keptWithin(w.start, w.end)
    if (kept < w.end - w.start - 0.005) {
      m.missingWords++
      if (kept > 0.005)
        for (const [x, y] of keptRanges)
          for (const b of [x, y])
            if (b > w.start + 0.005 && b < w.end - 0.005)
              m.wordsCut.push({ text: w.text, start: w.start, end: w.end, boundary: b })
    }
  }
  if (m.missingWords > 0)
    v.push(`カット: 言葉 ${m.missingWords}/${m.totalWords} 個が全部は残っていない`)
  for (const c of m.wordsCut)
    v.push(
      `カット: 「${c.text}」(${c.start.toFixed(2)}〜${c.end.toFixed(2)})の途中 ${c.boundary.toFixed(3)} で切った`
    )
  for (const [a, b] of [
    [60, 68],
    [106, 114]
  ]) {
    const kept = keptWithin(a + 0.5, b - 0.5)
    m.silenceKept[`${a}-${b}`] = kept
    if (kept > 1.0) v.push(`カット: 無音 ${a}〜${b} 秒のうち ${kept.toFixed(2)} 秒が残った`)
  }

  // --- 話者の判定と文字起こし: 正解の言葉がどれだけ、正しい話者の発話に入ったか
  {
    const gt = shoot.script.utterances.filter((u) => shoot.speakers.includes(u.speaker))
    const overlapsWith = (a: number, b: number, speaker?: number): boolean =>
      gt.some(
        (x) =>
          gt.some(
            (y) =>
              y !== x &&
              y.speaker !== x.speaker &&
              Math.min(x.end, y.end) > Math.max(x.start, y.start)
          ) &&
          (speaker === undefined || x.speaker === speaker) &&
          Math.min(x.end, b) > Math.max(x.start, a)
      )
    m.speakers.gtUtterances = gt.length
    m.speakers.gtOverlaps = gt.filter((x) =>
      gt.some((y) => y.start > x.start && y.start < x.end && y.speaker !== x.speaker)
    ).length
    const transcript = project.transcript ?? []
    m.speakers.utterances = transcript.length
    const nameOf = (spk: number): string | undefined =>
      spk === 1 ? '田中' : spk === 2 ? '佐藤' : undefined
    const hasMics = shoot.files.some((f) => f.kind === 'mic')
    for (const u of transcript) {
      const a = trueCommon(u.assetId, u.sourceStart)
      const b = trueCommon(u.assetId, u.sourceEnd)
      if (u.overlap) {
        m.speakers.flaggedOverlap++
        if (!overlapsWith(a, b)) m.speakers.flaggedWithoutOverlap++
      }
      for (const w of u.words) {
        const t = trueCommon(u.assetId, (w.start + w.end) / 2)
        const cands = gt
          .flatMap((x) => x.words)
          .filter((x) => t >= x.start - 0.01 && t <= x.end + 0.01 && x.text === w.text)
        if (cands.length === 0) continue
        m.speakers.wordsTranscribed++
        if (hasMics && !cands.some((g) => u.speaker === nameOf(g.speaker)))
          m.speakers.wrongSpeaker++
      }
    }
    // 正解の発話ごとに、言葉の頭と終わりが発話の区間(話者の判定)に入っているか
    for (const x of gt) {
      const cover = transcript.filter((u) => {
        const a = trueCommon(u.assetId, u.sourceStart)
        const b = trueCommon(u.assetId, u.sourceEnd)
        return (
          Math.min(b, x.end) > Math.max(a, x.start) && (!hasMics || u.speaker === nameOf(x.speaker))
        )
      })
      if (cover.length === 0) {
        v.push(
          `話者: ${nameOf(x.speaker)} の発話 ${x.start.toFixed(2)}〜${x.end.toFixed(2)} が文字起こしに無い`
        )
        continue
      }
      const a = Math.min(...cover.map((u) => trueCommon(u.assetId, u.sourceStart)))
      const b = Math.max(...cover.map((u) => trueCommon(u.assetId, u.sourceEnd)))
      m.speakers.turnLateStartMs = Math.max(m.speakers.turnLateStartMs, (x.start - a) * -1000)
      m.speakers.turnEarlyEndMs = Math.max(m.speakers.turnEarlyEndMs, (x.end - b) * 1000)
    }
    const total = gt.reduce((s, x) => s + x.words.length, 0)
    if (m.speakers.wordsTranscribed < total)
      v.push(
        `文字起こし: 言葉 ${total - m.speakers.wordsTranscribed}/${total} 個が発話に入らなかった`
      )
    if (m.speakers.wrongSpeaker > 0) v.push(`話者: ${m.speakers.wrongSpeaker} 語が別の話者になった`)
    if (m.speakers.flaggedWithoutOverlap > 0)
      v.push(
        `話者: 声が重なっていない発話 ${m.speakers.flaggedWithoutOverlap} 件を「重なり」にした`
      )
  }

  // --- 発言テロップ: 言葉の出る時刻と合っているか・重なり
  const speech = project.textOverlays.filter((o) => o.utteranceId)
  m.telop.count = speech.length
  const utt = new Map((project.transcript ?? []).map((u) => [u.id, u]))
  const cutsAt = pipe.lastSpans.slice(1).map((s) => s.timeline)
  for (const o of speech) {
    if (!(o.endTime > o.startTime))
      v.push(`テロップ: 「${o.text}」の長さが ${o.endTime - o.startTime}`)
    const u = utt.get(o.utteranceId!)
    if (!u) {
      v.push(`テロップ: 「${o.text}」の発話が文字起こしに無い`)
      continue
    }
    const truth = truthOfAsset.get(u.assetId)
    // テロップの文字が、発話の言葉のどこからどこか(言葉の時刻を文字で按分)
    const chars: { start: number; end: number }[] = []
    for (const w of u.words) {
      const cs = [...w.text]
      const step = (w.end - w.start) / cs.length
      cs.forEach((_, i) => chars.push({ start: w.start + step * i, end: w.start + step * (i + 1) }))
    }
    const full = u.words.map((w) => w.text).join('')
    const text = o.text.replace(/\s/g, '')
    // 同じ発話の前の枚の分を飛ばして探す
    const before = speech
      .filter(
        (x) => x.utteranceId === o.utteranceId && (x.utteranceChunk ?? 0) < (o.utteranceChunk ?? 0)
      )
      .reduce((s, x) => s + x.text.replace(/\s/g, '').length, 0)
    const idx = full.indexOf(text, Math.max(0, before - 2))
    if (idx < 0 || !truth) {
      v.push(`テロップ: 「${text}」が発話「${full}」の中に見つからない`)
      continue
    }
    const first = trueCommon(u.assetId, chars[idx].start)
    const last = trueCommon(u.assetId, chars[idx + text.length - 1].end)
    const s = commonAt(o.startTime)
    const e = commonAt(o.endTime, 'end')
    if (s === null || e === null) {
      v.push(`テロップ: 「${text}」が本編の外 (${o.startTime}〜${o.endTime})`)
      continue
    }
    // 頭: 言葉より前に出すぎない(最初の枚は 0.12 秒前・切れ目の直後なら切れ目から、の分は許す)
    // 切れ目から出す枚は、言葉の 0.3 秒(つなぐ幅)+ 話者の判定の余白 0.15 秒 前までありうる。
    // それ以外は、発話の区間の頭(声の 0.15 秒前)から 0.12 秒後。発話の区間の頭より前には出ない
    const early = first - s
    const atCut = cutsAt.some((c) => Math.abs(c - o.startTime) < 1e-6) || o.startTime < 1e-6
    if (atCut) m.telop.maxEarlyAtCutMs = Math.max(m.telop.maxEarlyAtCutMs, early * 1000)
    else m.telop.maxEarlyMs = Math.max(m.telop.maxEarlyMs, early * 1000)
    if (early > (atCut ? 0.45 : 0.15) + FRAME)
      v.push(
        `テロップ: 「${text}」が言葉より ${(early * 1000).toFixed(0)}ms 早く出る${atCut ? '(切れ目から)' : ''}`
      )
    if (s - first > FRAME)
      v.push(`テロップ: 「${text}」が言葉より ${((s - first) * 1000).toFixed(0)}ms 遅れて出る`)
    // 終わり: 言い終わる前に消えない
    const earlyEnd = last - e
    m.telop.maxEarlyEndMs = Math.max(m.telop.maxEarlyEndMs, earlyEnd * 1000)
    if (earlyEnd > FRAME)
      v.push(`テロップ: 「${text}」が言い終わる ${(earlyEnd * 1000).toFixed(0)}ms 前に消える`)
    m.telop.maxLateEndMs = Math.max(m.telop.maxLateEndMs, (e - last) * 1000)
    // 時間の飛ぶ切れ目をまたがない
    for (const c of cutsAt)
      if (c > o.startTime + 1e-6 && c < o.endTime - 1e-6)
        v.push(
          `テロップ: 「${text}」(${o.startTime.toFixed(2)}〜${o.endTime.toFixed(2)})がカットの切れ目 ${c.toFixed(2)} をまたぐ`
        )
  }
  // 同じ場所に同時に出る発言テロップ(下・自由配置なし)が重ならない
  const sorted = [...speech].sort((a, b) => a.startTime - b.startTime)
  const slotOf = (o: (typeof speech)[number]): string =>
    o.style.customPosition ? `c${o.style.customPosition.y.toFixed(3)}` : o.style.position
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length && sorted[j].startTime < sorted[i].endTime - 1e-6; j++)
      if (slotOf(sorted[i]) === slotOf(sorted[j]))
        v.push(
          `テロップ: 「${sorted[i].text}」(${sorted[i].startTime.toFixed(2)}〜${sorted[i].endTime.toFixed(2)}) と「${sorted[j].text}」(${sorted[j].startTime.toFixed(2)}〜) が同じ位置で重なる`
        )
  // 演出テロップ・ほかのテロップもタイムラインの中
  for (const o of project.textOverlays)
    if (o.startTime < -1e-6 || o.endTime > total + 1e-3)
      v.push(
        `テロップ: 「${o.text}」(${o.startTime.toFixed(2)}〜${o.endTime.toFixed(2)}) が本編 ${total.toFixed(2)} 秒の外`
      )
  for (const tr of [
    ...project.audioTracks.filter((t) => t.autoRole),
    ...project.videoOverlayTracks.filter((t) => t.autoRole)
  ])
    for (const c of tr.clips)
      if (c.startTime < -1e-6 || c.startTime > total + 1e-3)
        v.push(
          `仕上げ: ${tr.name} のクリップが ${c.startTime.toFixed(2)} 秒(本編 ${total.toFixed(2)} 秒の外)`
        )

  findNaN(project, 'project', m.nan)
  findNaN(
    {
      report: pipe.report,
      scenes: pipe.scenes,
      judgements: pipe.judgements,
      lastSpans: pipe.lastSpans,
      roughCut: pipe.roughCut,
      effects: pipe.effects
    },
    'pipeline',
    m.nan
  )
  for (const n of m.nan.slice(0, 20)) v.push(`NaN/Infinity: ${n}`)
  if (calls.unknown.length)
    v.push(`想定外の window.api 呼び出し: ${[...new Set(calls.unknown)].join(', ')}`)
  for (const [k, s] of Object.entries(pipe.steps))
    if (s.state === 'error' && !['color', 'denoise'].includes(k))
      v.push(`工程 ${k} が失敗: ${s.note}`)
  return m
}

// ---------------------------------------------------------------- 走らせる

async function runScenario(
  name: string,
  shoot: Shoot,
  kit: string,
  names: Record<string, string>
): Promise<Measured> {
  const calls: Calls = { asrJobs: [], llm: 0, unknown: [] }
  installApi(shoot, calls)
  useProjectStore.getState().newProject()
  usePipelineStore.getState().reset()
  useSettingsStore.setState({ aiProvider: 'local', showKitFolder: kit })
  let layoutSnapshot: Project | null = null
  const unsub = useProjectStore.subscribe((s) => {
    if (!layoutSnapshot && s.project.multicam && s.project.clips.length > 0)
      layoutSnapshot = s.project
  })
  try {
    await usePipelineStore.getState().scanFolder(shoot.root)
    for (const s of usePipelineStore.getState().sources) {
      const dev = shoot.files.find((f) => s.files.some((x) => x.relativePath === f.rel))?.device
      if (dev && names[dev]) usePipelineStore.getState().updateSource(s.id, { name: names[dev] })
    }
    await usePipelineStore.getState().runPipeline()
  } finally {
    unsub()
  }
  const m = verify(name, shoot, layoutSnapshot, calls)
  if (process.env.E2E_PIPELINE_DIR)
    writeFileSync(
      join(process.env.E2E_PIPELINE_DIR, `report-${name}.json`),
      JSON.stringify(
        {
          ...m,
          log: usePipelineStore.getState().log.map((l) => l.text),
          report: usePipelineStore.getState().report,
          spans: usePipelineStore.getState().lastSpans,
          telops: useProjectStore.getState().project.textOverlays.map((o) => ({
            text: o.text,
            s: o.startTime,
            e: o.endTime,
            u: o.utteranceId,
            fx: o.effectId
          })),
          asrJobs: calls.asrJobs
        },
        null,
        1
      )
    )
  return m
}

const NAMES = { mic1: '田中', mic2: '佐藤' }

describe.skipIf(!HAVE_FFMPEG)('自動編集を本物の素材で端から端まで', () => {
  let dir = ''
  let library: Library
  let kit = ''
  const keep = Boolean(process.env.E2E_PIPELINE_DIR)

  beforeAll(() => {
    dir = keep ? process.env.E2E_PIPELINE_DIR! : mkdtempSync(join(tmpdir(), 've-e2e-'))
    mkdirSync(dir, { recursive: true })
    state.cacheDir = join(dir, 'analysis-cache')
    rmSync(state.cacheDir, { recursive: true, force: true })
    library = makeLibrary(dir)
    kit = makeKit(dir)
  }, 60_000)

  afterAll(() => {
    if (!keep && dir) rmSync(dir, { recursive: true, force: true })
  })

  it('カメラ2台(1台は分割)+ ピンマイク2本(1本は時計が速い)', async () => {
    const shoot = makeShoot(library, dir, 'main', {
      CAM_A: ['A001'],
      CAM_B: ['B001', 'B002'],
      PIN_1: ['MIC1'],
      PIN_2: ['MIC2']
    })
    const m = await runScenario('main', shoot, kit, NAMES)
    console.log(JSON.stringify({ ...m, violations: m.violations.length }, null, 1))
    expect(m.violations).toEqual([])

    // 計器を先に疑う: 正解の側をずらすと、それぞれの確かめが落ちること
    const calls: Calls = { asrJobs: [], llm: 0, unknown: [] }
    const shifted = (device: string, by: number): Shoot => ({
      ...shoot,
      files: shoot.files.map((f) => (f.device === device ? { ...f, start: f.start + by } : f))
    })
    const mic2Late = verify('control', shifted('mic2', 0.05), null, calls).violations
    expect(mic2Late.some((x) => x.startsWith('同期: PIN_2/MIC2.WAV の頭が'))).toBe(true)
    expect(mic2Late.some((x) => x.startsWith('仮編集: 佐藤'))).toBe(true)
    const mic1Late = verify('control', shifted('mic1', 0.5), null, calls).violations
    expect(mic1Late.some((x) => /^テロップ: .*(早く出る|遅れて出る|前に消える)/.test(x))).toBe(true)
    const camBLate = verify('control', shifted('camB', 0.05), null, calls).violations
    expect(camBLate.some((x) => x.startsWith('仮編集: '))).toBe(true)
    // 無音の所に言葉を足すと「言葉が残っていない」になる
    const extra: Word = { speaker: 1, text: '足した', start: 63, end: 63.4, f0: 125 }
    const withWord: Shoot = {
      ...shoot,
      script: {
        ...shoot.script,
        utterances: [
          ...shoot.script.utterances,
          { speaker: 1, words: [extra], start: 63, end: 63.4 }
        ]
      }
    }
    const missing = verify('control', withWord, null, calls).violations
    expect(missing.some((x) => x.startsWith('カット: 言葉 1/188'))).toBe(true)

    // 人が本編にクリップを差し込んでから仮編集を作り直しても、効果音は演出テロップと同じ時刻
    // (差し込んだ長さぶん早くずれていた)
    const P = useProjectStore.getState()
    const cam = P.project.assets.find((a) => a.hasVideo)!
    P.addAsset({ ...cam, id: 'inserted-broll' })
    // 演出テロップ(3 秒〜)より前に差し込む
    const at = 1
    P.insertClipAtTime('inserted-broll', 0, 3, at)
    installApi(shoot, calls)
    await usePipelineStore.getState().rebuildRoughCut()
    const after = useProjectStore.getState().project
    expect(after.clips.some((c) => c.assetId === 'inserted-broll')).toBe(true)
    const se = after.audioTracks.filter((t) => t.autoRole === 'se').flatMap((t) => t.clips)
    const fx = after.textOverlays.filter((o) => o.effectId && o.startTime > at + 3)
    expect(fx.length).toBeGreaterThan(0)
    const seAt = se.map((c) => c.startTime)
    const nearSe = fx.filter((o) => seAt.some((t) => Math.abs(t - o.startTime) < 0.15))
    const earlySe = fx.filter((o) => seAt.some((t) => Math.abs(t - (o.startTime - 3)) < 0.15))
    expect(nearSe.length).toBeGreaterThan(0)
    expect(earlySe.length).toBe(0)
  }, 120_000)

  it('カメラ1台だけ(ピンマイク無し)', async () => {
    const shoot = makeShoot(library, dir, 'single', { CAM_A: ['A001'] })
    const m = await runScenario('single', shoot, kit, NAMES)
    console.log(JSON.stringify({ ...m, violations: m.violations.length }, null, 1))
    expect(m.violations).toEqual([])
  }, 60_000)

  it('音の無いカメラがある', async () => {
    const shoot = makeShoot(library, dir, 'mutecam', {
      CAM_A: ['A001'],
      CAM_B: ['B001_mute', 'B002_mute'],
      PIN_1: ['MIC1'],
      PIN_2: ['MIC2']
    })
    const m = await runScenario('mutecam', shoot, kit, NAMES)
    console.log(JSON.stringify({ ...m, violations: m.violations.length }, null, 1))
    // 音の無いカメラ B は合わせられない(並ばない)のが正しい
    expect(m.violations.filter((x) => !/B00[12]\.MP4 が並ばなかった/.test(x))).toEqual([])
  }, 60_000)

  it('どこにも合わないピンマイクがある', async () => {
    const shoot = makeShoot(library, dir, 'stranger', {
      CAM_A: ['A001'],
      CAM_B: ['B001', 'B002'],
      PIN_1: ['MIC1'],
      PIN_2: ['MIC2'],
      PIN_3: ['MIC3']
    })
    const m = await runScenario('stranger', shoot, kit, { ...NAMES, mic3: '山田' })
    console.log(JSON.stringify({ ...m, violations: m.violations.length }, null, 1))
    expect(m.violations).toEqual([])
  }, 60_000)
})

import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, ffprobePath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { targetFrameRate } from '@shared/frameRate'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { planTelopRuns, type TelopLayerPayload } from '@shared/telop/layer'
import { targetResolution, textCanvasSize } from '@shared/resolution'
import { defaultTextStyle } from '@shared/textStyle'
import type { SegmentPlanOptions } from '@shared/sequence/segmentPlan'
import type { MediaAsset, Project } from '@shared/types'

/**
 * **書き出しの受け入れ試験(同梱の ffmpeg で実際に書き出して、出来た mp4 を読んで確かめる)。**
 *
 * 素材は「自分の時刻を絵と音に書き込んだ」もの:
 * - 絵: 左半分に 4×6 の白黒のマス(24 bit)。下位 20 bit が素材のフレーム番号、上位 4 bit が素材の番号。
 *   右半分は灰色(128)で、ワイプとテロップを読む場所に使う。
 * - 音: 素材ごとに違う高さ(100Hz の倍数)のビープを毎秒ちょうどの所で 50ms 鳴らす。
 *
 * 書き出した mp4 を全フレーム読み、どのフレームに素材のどのフレームが出ているか・ワイプとテロップが
 * どのフレームに出ているか・ビープが何秒に鳴っているかを、タイムラインから計算した期待値と比べる。
 * 標準(`exportProject`)と区間分割(`exportSequenceSegmented`)の両方で書き出し、両者の絵も比べる。
 *
 * - 既定: 短い企画をいくつか(数十秒で終わる)
 * - `E2E_EXPORT_FULL=1`: 29.97fps だけの企画と、10分・テロップ数百枚の長尺も足す
 * - `E2E_EXPORT_DIR=<dir>`: 素材・出力・報告(report.json)をそこへ残す
 * - 【直した穴】の印の所は、直す前に落ちていた確かめ(いまは理想の値で確かめる)
 */

const HAVE_FFMPEG = existsSync(ffmpegPath) && existsSync(ffprobePath)
const FULL = process.env.E2E_EXPORT_FULL === '1'
const KEEP_DIR = process.env.E2E_EXPORT_DIR
/** 既知の穴(【直した穴】の印)も理想の値で確かめる。直したらこれで通るはず */
// 見つかった穴(区間の境目・格子・ワイプの端・ダッキング)は直したので、理想の値で確かめる
const STRICT = true

// ------------------------------------------------------------------ 素材

interface SourceSpec {
  key: string
  /** 絵に書き込む素材の番号(1〜15) */
  id: number
  kind: 'video' | 'beeps' | 'tone'
  fps?: string
  dur: number
  pitch: number
  /** tone の振幅(既定 0.3) */
  amp?: number
}

const SRC_W = 320
const SRC_H = 180
const BEEP_AMP = 0.5
const BEEP_LEN = 0.05

const SOURCES: SourceSpec[] = [
  { key: 'A30', id: 1, kind: 'video', fps: '30', dur: 70, pitch: 500 },
  { key: 'B2997', id: 2, kind: 'video', fps: '30000/1001', dur: 70, pitch: 800 },
  { key: 'C60', id: 3, kind: 'video', fps: '60', dur: 30, pitch: 1200 },
  { key: 'D60pip', id: 4, kind: 'video', fps: '60', dur: 20, pitch: 1900 },
  { key: 'Ebgm', id: 0, kind: 'beeps', dur: 40, pitch: 2900 },
  { key: 'Fsfx', id: 0, kind: 'beeps', dur: 10, pitch: 4100 },
  { key: 'Gtone', id: 0, kind: 'tone', dur: 40, pitch: 3500, amp: 0.3 }
]

let work = ''
const assets = new Map<string, MediaAsset>()
const specByKey = new Map(SOURCES.map((s) => [s.key, s]))

function ff(args: string[]): Buffer {
  return execFileSync(ffmpegPath, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 30 })
}

async function makeSource(s: SourceSpec): Promise<MediaAsset> {
  const dir = join(work, 'src')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${s.key}.${s.kind === 'video' ? 'mp4' : 'wav'}`)
  const beep = `${BEEP_AMP}*sin(2*PI*${s.pitch}*t)*lt(mod(t,1),${BEEP_LEN})`
  const tone = `${s.amp ?? 0.3}*sin(2*PI*${s.pitch}*t)`
  const expr = s.kind === 'tone' ? tone : beep
  const audio = `aevalsrc=exprs='${expr}|${expr}':s=48000:d=${s.dur}:c=stereo`
  if (!existsSync(path)) {
    if (s.kind === 'video') {
      // 8x6 の絵に1画素1bit で書いてから、拡大(最近傍)して 40x30 のマスにする
      const code = `if(lt(X,4),if(mod(floor((N+${s.id * 1048576})/pow(2,Y*4+X)),2),235,16),128)`
      const video =
        `color=c=gray:s=8x6:r=${s.fps}:d=${s.dur},format=gray,geq=lum='${code}',` +
        `scale=${SRC_W}:${SRC_H}:flags=neighbor,setsar=1,format=yuv420p`
      ff([
        '-f',
        'lavfi',
        '-i',
        video,
        '-f',
        'lavfi',
        '-i',
        audio,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '12',
        '-g',
        '30',
        '-c:a',
        'aac',
        '-b:a',
        '256k',
        path
      ])
    } else {
      ff(['-f', 'lavfi', '-i', audio, '-c:a', 'pcm_s16le', path])
    }
  }
  const probe = await probeMedia(path)
  return {
    id: s.key,
    filePath: path,
    fileName: `${s.key}`,
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    hasAudio: probe.hasAudio,
    hasVideo: probe.hasVideo
  }
}

// ------------------------------------------------------------------ 企画

interface MainSpec {
  src: string
  in: number
  out: number
  speed?: number
}
interface PipSpec {
  src: string
  start: number
  in: number
  out: number
}
interface AudioClipSpec {
  src: string
  start: number
  in: number
  out: number
  volume?: number
  fadeIn?: number
  fadeOut?: number
}
interface AudioTrackSpec {
  volume: number
  ducking?: boolean
  clips: AudioClipSpec[]
}
interface TelopSpec {
  start: number
  end: number
}
interface Case {
  name: string
  main: MainSpec[]
  pip?: PipSpec[]
  audio?: AudioTrackSpec[]
  telops?: TelopSpec[]
  /** 区間分割を既定とは別の長さでも書き出す */
  segOptions?: SegmentPlanOptions
}

const PIP_SCALE = 0.3
const OUT_H = 480
const { w: OUT_W } = targetResolution('16:9', OUT_H)
/** テロップの PNG に描く板(右下・本編の灰色の上) */
const TELOP_RECT = { x0: 600, y0: 300, x1: 820, y1: 460 }
const TELOP_LEVELS = [20, 70, 190, 240]

function buildProject(c: Case): Project {
  const used = new Set<string>([
    ...c.main.map((m) => m.src),
    ...(c.pip ?? []).map((p) => p.src),
    ...(c.audio ?? []).flatMap((t) => t.clips.map((k) => k.src))
  ])
  return {
    id: c.name,
    name: c.name,
    aspectRatio: '16:9',
    assets: [...used].map((k) => assets.get(k)!),
    clips: c.main.map((m, i) => ({
      id: `c${i}`,
      assetId: m.src,
      inPoint: m.in,
      outPoint: m.out,
      speed: m.speed ?? 1
    })),
    videoOverlayTracks: c.pip
      ? [
          {
            id: 'pip',
            name: 'PiP',
            hidden: false,
            position: 'top-right',
            scale: PIP_SCALE,
            clips: c.pip.map((p, i) => ({
              id: `p${i}`,
              assetId: p.src,
              startTime: p.start,
              inPoint: p.in,
              outPoint: p.out
            }))
          }
        ]
      : [],
    audioTracks: (c.audio ?? []).map((t, ti) => ({
      id: `at${ti}`,
      name: `A${ti}`,
      muted: false,
      volume: t.volume,
      duckingEnabled: t.ducking ?? false,
      clips: t.clips.map((k, ki) => ({
        id: `at${ti}_${ki}`,
        assetId: k.src,
        startTime: k.start,
        inPoint: k.in,
        outPoint: k.out,
        ...(k.volume !== undefined ? { volume: k.volume } : {}),
        ...(k.fadeIn ? { fadeIn: k.fadeIn } : {}),
        ...(k.fadeOut ? { fadeOut: k.fadeOut } : {})
      }))
    })),
    textOverlays: (c.telops ?? []).map((t, i) => ({
      id: `t${i}`,
      text: `T${i}`,
      startTime: t.start,
      endTime: t.end,
      style: defaultTextStyle()
    }))
  }
}

/** テロップ i の色(隣り合うものが必ず違う色になるよう 4 色を回す) */
const telopLevel = (i: number): number => TELOP_LEVELS[i % TELOP_LEVELS.length]

function telopPng(name: string, level: number | null): Uint8Array {
  const path = join(work, 'telop-png', name)
  mkdirSync(join(work, 'telop-png'), { recursive: true })
  const { x0, y0, x1, y1 } = TELOP_RECT
  const a = level === null ? '0' : `if(between(X,${x0},${x1 - 1})*between(Y,${y0},${y1 - 1}),255,0)`
  const l = level ?? 0
  if (!existsSync(path)) {
    ff([
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${OUT_W}x${OUT_H}:d=0.04,format=rgba,geq=r=${l}:g=${l}:b=${l}:a='${a}'`,
      '-frames:v',
      '1',
      path
    ])
  }
  return new Uint8Array(readFileSync(path))
}

/**
 * アプリと同じ作り方の層: v2 へ写し(`projectV1ToV2`)、`planTelopRuns` で区間を作り、
 * 同じ絵の区間は同じ画像を使う。絵は `drawTelop` の代わりにテロップごとの色の板。
 */
function telopLayerFor(project: Project): TelopLayerPayload | null {
  const v2 = projectV1ToV2(project, { resolution: OUT_H })
  const runs = planTelopRuns(v2.sequence, textCanvasSize('16:9').h)
  if (runs.length === 0) return null
  const images: Uint8Array[] = [telopPng('empty.png', null)]
  const imageByKey = new Map<string, number>()
  const out: TelopLayerPayload['runs'] = []
  for (const r of runs) {
    let img = imageByKey.get(r.imageKey)
    if (img === undefined) {
      if (r.itemIds.length !== 1) throw new Error('試験の企画でテロップが重なっている')
      const idx = Number(r.itemIds[0].slice(1))
      images.push(telopPng(`L${telopLevel(idx)}.png`, telopLevel(idx)))
      img = images.length - 1
      imageByKey.set(r.imageKey, img)
    }
    out.push({ startFrame: r.startFrame, endFrame: r.endFrame, image: img })
  }
  return { width: v2.sequence.width, height: v2.sequence.height, images, runs: out }
}

// ------------------------------------------------------------------ 期待値(アプリの関数を使わずに計算する)

interface Expect {
  fps: number
  totalFrames: number
  /** 本編: クリップごとの [始まりのフレーム, フレーム数] */
  clips: { start: number; frames: number; spec: MainSpec; srcFps: number; srcId: number }[]
  pip: {
    start: number
    end: number
    exportStart: number
    spec: PipSpec
    srcFps: number
    srcId: number
  }[]
  telops: { start: number; end: number; level: number }[]
  beeps: {
    pitch: number
    t: number
    amp: number
    what: string
    optional?: boolean
    slow?: boolean
  }[]
}

function expectedFor(c: Case): Expect {
  const fpsList = c.main.map((m) => assets.get(m.src)!.fps)
  // アプリと同じ決め方(29.97 などの素材は 30000/1001 のまま)
  const fps = targetFrameRate(fpsList)
  let acc = 0
  const clips = c.main.map((m) => {
    const frames = Math.round(((m.out - m.in) / (m.speed ?? 1)) * fps)
    const r = {
      start: acc,
      frames,
      spec: m,
      srcFps: assets.get(m.src)!.fps,
      srcId: specByKey.get(m.src)!.id
    }
    acc += frames
    return r
  })
  const totalFrames = acc
  const total = totalFrames / fps
  /**
   * タイムラインの秒 → 書き出しの秒。本編の各クリップはフレーム数に丸めて並ぶので、
   * その上に置いた物(テロップ・ワイプ・音声トラック)は「始まりを含むクリップの頭からの秒」を保って動く
   * (アプリの決まり: `exportTimeline.ts`)。ここではそれを素朴に計算し直す
   */
  const tlStarts: number[] = []
  {
    let t = 0
    for (const m of c.main) {
      tlStarts.push(t)
      t += (m.out - m.in) / (m.speed ?? 1)
    }
  }
  const map = (t: number): number => {
    let i = 0
    for (let k = 0; k < tlStarts.length; k++) if (tlStarts[k] <= t) i = k
    return Math.max(0, t - tlStarts[i] + clips[i].start / fps)
  }
  const pip = (c.pip ?? []).map((p) => ({
    start: Math.round(map(p.start) * fps),
    end: Math.min(totalFrames, Math.round(map(p.start + p.out - p.in) * fps)),
    exportStart: map(p.start),
    spec: p,
    srcFps: assets.get(p.src)!.fps,
    srcId: specByKey.get(p.src)!.id
  }))
  const telops = (c.telops ?? []).map((t, i) => ({
    start: Math.round(map(t.start) * fps),
    end: Math.min(totalFrames, Math.round(map(t.end) * fps)),
    level: telopLevel(i)
  }))
  const beeps: Expect['beeps'] = []
  const addBeeps = (
    pitch: number,
    srcIn: number,
    srcOut: number,
    at: number,
    speed: number,
    amp: (t: number) => number,
    what: string
  ): void => {
    for (let s = Math.floor(srcIn); s < srcOut; s++) {
      // ビープが 15ms 以上入っていないものは数えない(イン点がビープの途中なら、クリップの頭から鳴る)
      if (srcOut - s < 0.015 * speed) continue
      const partial = s < srcIn - 1e-9
      if (partial && s + BEEP_LEN - srcIn < 0.005) continue
      const t = at + Math.max(0, s - srcIn) / speed
      if (t > total - 0.015) continue
      // 頭が欠けたビープ(イン点がビープの途中)は短いので、聞こえても聞こえなくてもよい
      beeps.push({
        pitch,
        t,
        amp: amp(t),
        what,
        ...(partial ? { optional: true } : {}),
        ...(speed < 1 ? { slow: true } : {})
      })
    }
  }
  clips.forEach((k, i) => {
    const spec = specByKey.get(k.spec.src)!
    addBeeps(
      spec.pitch,
      k.spec.in,
      k.spec.out,
      k.start / fps,
      k.spec.speed ?? 1,
      () => BEEP_AMP,
      `main#${i}`
    )
  })
  ;(c.pip ?? []).forEach((p, i) => {
    const spec = specByKey.get(p.src)!
    addBeeps(spec.pitch, p.in, p.out, map(p.start), 1, () => BEEP_AMP, `pip#${i}`)
  })
  ;(c.audio ?? []).forEach((tr, ti) => {
    tr.clips.forEach((k, ki) => {
      const spec = specByKey.get(k.src)!
      if (spec.kind !== 'beeps') return
      const dur = k.out - k.in
      const at = map(k.start)
      const gain = (t: number): number => {
        // ビープの山(頭から 30ms)での音量
        const local = t + 0.03 - at
        let g = tr.volume * (k.volume ?? 1)
        if (k.fadeIn) g *= Math.min(1, Math.max(0, local / k.fadeIn))
        if (k.fadeOut) g *= Math.min(1, Math.max(0, (dur - local) / k.fadeOut))
        return BEEP_AMP * g
      }
      addBeeps(spec.pitch, k.in, k.out, at, 1, gain, `audio${ti}#${ki}`)
    })
  })
  return { fps, totalFrames, clips, pip, telops, beeps }
}

// ------------------------------------------------------------------ 出力を読む

interface Decoded {
  frames: number
  mainId: Int8Array
  mainFrame: Int32Array
  mainConf: Uint8Array
  pipId: Int8Array
  pipFrame: Int32Array
  pipConf: Uint8Array
  telopLum: Uint8Array
}

function codeReader(
  ox: number,
  oy: number,
  scale: number
): (buf: Buffer, W: number) => { id: number; frame: number; conf: number } {
  const pts: [number, number][] = []
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 4; c++) {
      pts.push([Math.round(ox + (40 * c + 20) * scale), Math.round(oy + (30 * r + 15) * scale)])
    }
  }
  return (buf, W) => {
    let v = 0
    let conf = 255
    pts.forEach(([x, y], k) => {
      let s = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) s += buf[(y + dy) * W + x + dx]
      const lum = s / 9
      if (lum > 128) v += 2 ** k
      conf = Math.min(conf, Math.abs(lum - 128))
    })
    return { id: Math.floor(v / 1048576), frame: v % 1048576, conf: Math.round(conf) }
  }
}

function decodeVideo(file: string, maxFrames: number): Promise<Decoded> {
  const W = OUT_W
  const H = OUT_H
  const frameSize = W * H
  const s = Math.min(W / SRC_W, H / SRC_H)
  const main = codeReader((W - SRC_W * s) / 2, (H - SRC_H * s) / 2, s)
  const pipW = Math.max(2, Math.round((W * PIP_SCALE) / 2) * 2)
  const margin = Math.round(W * 0.04)
  const pip = codeReader(W - pipW - margin, margin, pipW / SRC_W)
  const cap = maxFrames + 64
  const d: Decoded = {
    frames: 0,
    mainId: new Int8Array(cap),
    mainFrame: new Int32Array(cap),
    mainConf: new Uint8Array(cap),
    pipId: new Int8Array(cap),
    pipFrame: new Int32Array(cap),
    pipConf: new Uint8Array(cap),
    telopLum: new Uint8Array(cap)
  }
  const tx = Math.round((TELOP_RECT.x0 + TELOP_RECT.x1) / 2)
  const ty = Math.round((TELOP_RECT.y0 + TELOP_RECT.y1) / 2)
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        file,
        '-map',
        '0:v:0',
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let pending: Buffer = Buffer.alloc(0)
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length >= frameSize) {
        const buf = pending.subarray(0, frameSize)
        const k = d.frames++
        if (k < cap) {
          const m = main(buf, W)
          d.mainId[k] = m.id
          d.mainFrame[k] = m.frame
          d.mainConf[k] = m.conf
          const p = pip(buf, W)
          d.pipId[k] = p.id
          d.pipFrame[k] = p.frame
          d.pipConf[k] = p.conf
          let t = 0
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) t += buf[(ty + dy) * W + tx + dx]
          d.telopLum[k] = Math.round(t / 25)
        }
        pending = pending.subarray(frameSize)
      }
    })
    let err = ''
    child.stderr.on('data', (c: Buffer) => (err += c.toString()))
    child.on('close', (code) => {
      if (process.env.E2E_DEBUG) console.log('close', code, d.frames)
      if (code === 0) resolve(d)
      else reject(new Error(err))
    })
  })
}

function decodeAudioLeft(file: string): Float32Array {
  const raw = ff(['-i', file, '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-f', 'f32le', '-'])
  const all = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4))
  const left = new Float32Array(Math.floor(all.length / 2))
  for (let i = 0; i < left.length; i++) left[i] = all[2 * i]
  return left
}

interface Probe {
  formatDuration: number
  vStart: number
  aStart: number
  vDuration: number
  aDuration: number
  vRate: string
  /** 映像のパケットの時刻の刻みが 1/fps からずれた数 */
  ptsIrregular: number
  ptsCount: number
}

function probeOut(file: string, fps: number): Probe {
  const j = JSON.parse(
    execFileSync(ffprobePath, [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,start_time,duration,r_frame_rate',
      '-of',
      'json',
      file
    ]).toString()
  )
  const v = j.streams.find((s: { codec_type: string }) => s.codec_type === 'video')
  const a = j.streams.find((s: { codec_type: string }) => s.codec_type === 'audio')
  const pts = execFileSync(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time',
      '-of',
      'csv=p=0',
      file
    ],
    { maxBuffer: 1 << 28 }
  )
    .toString()
    .split('\n')
    .map((l) => l.trim().replace(/,$/, ''))
    .filter((l) => l !== '')
    .map(Number)
    .filter((x) => Number.isFinite(x))
    .sort((x, y) => x - y)
  let irregular = 0
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i] - pts[i - 1] - 1 / fps) > 0.25 / fps) irregular++
  }
  return {
    formatDuration: Number(j.format.duration),
    vStart: Number(v?.start_time ?? NaN),
    aStart: Number(a?.start_time ?? NaN),
    vDuration: Number(v?.duration ?? NaN),
    aDuration: Number(a?.duration ?? NaN),
    vRate: v?.r_frame_rate ?? '',
    ptsIrregular: irregular,
    ptsCount: pts.length
  }
}

/** 高さ `pitch` の音の振幅(直近 10ms の窓)を 0.5ms ごとに */
function toneEnvelope(
  x: Float32Array,
  pitch: number
): { mag: Float32Array; hop: number; win: number } {
  const SR = 48000
  const win = 480
  const hop = 24
  const n = x.length
  const mag = new Float32Array(Math.floor(n / hop) + 1)
  let re = 0
  let im = 0
  const w = (2 * Math.PI * pitch) / SR
  // 窓の和を順に足し引きする(位相は絶対サンプル位置で取るので、足し引きで揃う)
  const c = (i: number): number => Math.cos(w * i)
  const s = (i: number): number => Math.sin(w * i)
  for (let i = 0; i < n; i++) {
    re += x[i] * c(i)
    im -= x[i] * s(i)
    if (i >= win) {
      const j = i - win
      re -= x[j] * c(j)
      im += x[j] * s(j)
    }
    if (i % hop === 0) mag[i / hop] = (Math.hypot(re, im) * 2) / win
  }
  return { mag, hop, win }
}

interface Onset {
  t: number
  amp: number
}

function detectOnsets(x: Float32Array, pitch: number, thr = 0.1): Onset[] {
  const SR = 48000
  const { mag, hop, win } = toneEnvelope(x, pitch)
  const out: Onset[] = []
  let i = 0
  let floor = 0
  const look = Math.round((0.06 * SR) / hop)
  while (i < mag.length) {
    if (mag[i] < thr) {
      i++
      continue
    }
    // 山: ここから 60ms の最大
    let peak = 0
    for (let k = i; k < Math.min(mag.length, i + look); k++) peak = Math.max(peak, mag[k])
    // 頭: 山の半分を最初に超えた所(窓は後ろ向き 10ms なので、半分になるのは頭から 5ms 後)
    let h = Math.max(floor, i - Math.round((0.012 * SR) / hop))
    while (h < i + look && mag[h] < peak / 2) h++
    out.push({ t: (h * hop - win / 2) / SR, amp: peak })
    // 鳴り終わるまで飛ばす
    let k = Math.max(h, i)
    while (k < mag.length && mag[k] >= Math.min(thr, peak / 4)) k++
    i = k + 1
    floor = i
  }
  return out
}

// ------------------------------------------------------------------ 照合

interface VideoReport {
  decodedFrames: number
  expectedFrames: number
  /** 本編: 期待した素材と違う(番号・読めない)フレーム数 */
  mainWrongSource: number[]
  /** 本編: 素材のフレーム番号 − 理想(その時刻に出ているべき素材のフレーム) */
  mainErrHist: Record<string, number>
  mainWorst: { frame: number; clip: number; got: number; ideal: number }[]
  /** 本編: 「ぴったり」のはずの組み合わせ(素材とタイムラインが同じ fps の整数倍)でずれたフレーム */
  mainExactViolations: number
  perClip: {
    clip: number
    first: number
    firstIdeal: number
    last: number
    lastIdeal: number
    maxAbsErr: number
  }[]
  /**
   * 本編: 出ている素材のフレームの時刻 − その出力フレームの時刻に出ているべき素材の時刻(ms)。
   * 理想(その時刻を含むフレーム)なら (−1素材フレーム, 0]。正なら絵が音より先に進んでいる
   */
  mainLeadMs: { min: number; max: number }
  pipLeadMs: { min: number; max: number }
  pipWrongPresence: number[]
  pipErrHist: Record<string, number>
  pipEdges: { start: number; end: number; firstSeen: number; lastSeen: number }[]
  telopWrong: number[]
  telopEdges: { start: number; end: number; firstSeen: number; lastSeen: number }[]
}

function hist(m: Record<string, number>, v: number): void {
  const k = String(v)
  m[k] = (m[k] ?? 0) + 1
}

function checkVideo(e: Expect, d: Decoded): VideoReport {
  const F = e.fps
  const r: VideoReport = {
    decodedFrames: d.frames,
    expectedFrames: e.totalFrames,
    mainWrongSource: [],
    mainErrHist: {},
    mainWorst: [],
    mainExactViolations: 0,
    perClip: [],
    pipWrongPresence: [],
    pipErrHist: {},
    pipEdges: [],
    telopWrong: [],
    telopEdges: [],
    mainLeadMs: { min: Infinity, max: -Infinity },
    pipLeadMs: { min: Infinity, max: -Infinity }
  }
  const n = Math.min(d.frames, e.totalFrames)
  e.clips.forEach((c, ci) => {
    const speed = c.spec.speed ?? 1
    const ratio = (c.srcFps * speed) / F
    const exact =
      Math.abs(c.srcFps - Math.round(c.srcFps)) < 1e-6 &&
      Math.abs(ratio * 2 - Math.round(ratio * 2)) < 1e-9 &&
      Math.abs(c.spec.in * c.srcFps - Math.round(c.spec.in * c.srcFps)) < 1e-6
    const pc = { clip: ci, first: -1, firstIdeal: -1, last: -1, lastIdeal: -1, maxAbsErr: 0 }
    for (let j = 0; j < c.frames; j++) {
      const k = c.start + j
      if (k >= n) break
      const srcTime = c.spec.in + (j * speed) / F
      const ideal = Math.floor(srcTime * c.srcFps + 1e-6)
      if (d.mainId[k] !== c.srcId || d.mainConf[k] < 40) {
        r.mainWrongSource.push(k)
        continue
      }
      const err = d.mainFrame[k] - ideal
      hist(r.mainErrHist, err)
      const lead = (d.mainFrame[k] / c.srcFps - srcTime) * 1000
      r.mainLeadMs.min = Math.min(r.mainLeadMs.min, lead)
      r.mainLeadMs.max = Math.max(r.mainLeadMs.max, lead)
      if (exact && err !== 0) r.mainExactViolations++
      pc.maxAbsErr = Math.max(pc.maxAbsErr, Math.abs(err))
      if (Math.abs(err) >= 1 && r.mainWorst.length < 40) {
        r.mainWorst.push({ frame: k, clip: ci, got: d.mainFrame[k], ideal })
      }
      if (j === 0) {
        pc.first = d.mainFrame[k]
        pc.firstIdeal = ideal
      }
      pc.last = d.mainFrame[k]
      pc.lastIdeal = ideal
    }
    r.perClip.push(pc)
  })
  // ワイプ
  for (let k = 0; k < n; k++) {
    const p = e.pip.find((q) => k >= q.start && k < q.end)
    const seen = d.pipConf[k] >= 40 && p !== undefined && d.pipId[k] === p.srcId
    const anySeen = d.pipConf[k] >= 40 && d.pipId[k] > 0
    if (Boolean(p) !== anySeen || (p && !seen)) r.pipWrongPresence.push(k)
    if (p && seen) {
      const srcTime = p.spec.in + (k / F - p.exportStart)
      hist(r.pipErrHist, d.pipFrame[k] - Math.floor(srcTime * p.srcFps + 1e-6))
      const lead = (d.pipFrame[k] / p.srcFps - srcTime) * 1000
      r.pipLeadMs.min = Math.min(r.pipLeadMs.min, lead)
      r.pipLeadMs.max = Math.max(r.pipLeadMs.max, lead)
    }
  }
  for (const p of e.pip) {
    let first = -1
    let last = -1
    for (let k = Math.max(0, p.start - 5); k < Math.min(n, p.end + 5); k++) {
      if (d.pipConf[k] >= 40 && d.pipId[k] === p.srcId) {
        if (first < 0) first = k
        last = k
      }
    }
    r.pipEdges.push({ start: p.start, end: p.end, firstSeen: first, lastSeen: last })
  }
  // テロップ
  const classify = (lum: number): number => {
    const cands = [128, ...TELOP_LEVELS]
    return cands.reduce((b, c) => (Math.abs(c - lum) < Math.abs(b - lum) ? c : b), 128)
  }
  for (let k = 0; k < n; k++) {
    const t = e.telops.find((q) => k >= q.start && k < q.end)
    const want = t ? t.level : 128
    if (classify(d.telopLum[k]) !== want) r.telopWrong.push(k)
  }
  for (const t of e.telops) {
    let first = -1
    let last = -1
    for (let k = Math.max(0, t.start - 5); k < Math.min(n, t.end + 5); k++) {
      if (classify(d.telopLum[k]) === t.level) {
        if (first < 0) first = k
        last = k
      }
    }
    r.telopEdges.push({ start: t.start, end: t.end, firstSeen: first, lastSeen: last })
  }
  return r
}

interface AudioReport {
  samples: number
  expected: number
  matched: number
  missing: { what: string; t: number }[]
  /** 検出 − 期待(ms) */
  errMs: { min: number; max: number; meanAbs: number }
  /** 速度 1 未満のクリップのビープだけ(atempo で伸ばした音) */
  slowErrMs: { min: number; max: number }
  /** それ以外 */
  normalErrMs: { min: number; max: number }
  worst: { what: string; t: number; errMs: number }[]
  /** 振幅の比(dB)。フェード・音量の確認 */
  ampDb: { min: number; max: number }
  ampWorst: { what: string; t: number; db: number }[]
  unexpected: { pitch: number; t: number; amp: number }[]
  /** 本編の前半/後半の音ズレの平均(ms)。長尺の積み上がりを見る */
  driftMs?: { firstHalf: number; secondHalf: number }
}

function checkAudio(e: Expect, x: Float32Array): AudioReport {
  const pitches = [...new Set(e.beeps.map((b) => b.pitch))]
  const det = new Map(pitches.map((p) => [p, detectOnsets(x, p)]))
  const used = new Map(pitches.map((p) => [p, new Set<number>()]))
  const r: AudioReport = {
    samples: x.length,
    expected: e.beeps.length,
    matched: 0,
    missing: [],
    errMs: { min: Infinity, max: -Infinity, meanAbs: 0 },
    slowErrMs: { min: Infinity, max: -Infinity },
    normalErrMs: { min: Infinity, max: -Infinity },
    worst: [],
    ampDb: { min: Infinity, max: -Infinity },
    ampWorst: [],
    unexpected: []
  }
  const errs: { t: number; err: number; what: string }[] = []
  for (const b of e.beeps) {
    const list = det.get(b.pitch)!
    let best = -1
    for (let i = 0; i < list.length; i++) {
      if (
        Math.abs(list[i].t - b.t) < 0.1 &&
        (best < 0 || Math.abs(list[i].t - b.t) < Math.abs(list[best].t - b.t))
      )
        best = i
    }
    if (best < 0) {
      // 小さすぎて検出の閾値に届かない(フェードの端)ものは数えない
      if (b.amp >= 0.15 && !b.optional) r.missing.push({ what: b.what, t: b.t })
      continue
    }
    used.get(b.pitch)!.add(best)
    r.matched++
    const err = (list[best].t - b.t) * 1000
    errs.push({ t: b.t, err, what: b.what })
    const bucket = b.slow ? r.slowErrMs : r.normalErrMs
    bucket.min = Math.min(bucket.min, err)
    bucket.max = Math.max(bucket.max, err)
    if (b.amp >= 0.15) {
      const db = 20 * Math.log10(list[best].amp / b.amp)
      r.ampDb.min = Math.min(r.ampDb.min, db)
      r.ampDb.max = Math.max(r.ampDb.max, db)
      if (Math.abs(db) > 1.5) r.ampWorst.push({ what: b.what, t: b.t, db })
    }
  }
  for (const p of pitches) {
    det.get(p)!.forEach((o, i) => {
      if (!used.get(p)!.has(i)) r.unexpected.push({ pitch: p, t: o.t, amp: o.amp })
    })
  }
  if (errs.length) {
    r.errMs.min = Math.min(...errs.map((q) => q.err))
    r.errMs.max = Math.max(...errs.map((q) => q.err))
    r.errMs.meanAbs = errs.reduce((s, q) => s + Math.abs(q.err), 0) / errs.length
    r.worst = [...errs]
      .sort((a, b) => Math.abs(b.err) - Math.abs(a.err))
      .slice(0, 8)
      .map((q) => ({ what: q.what, t: q.t, errMs: q.err }))
    const mains = errs.filter((q) => q.what.startsWith('main'))
    const total = e.totalFrames / e.fps
    const half = (f: (q: { t: number }) => boolean): number => {
      const s = mains.filter(f)
      return s.length ? s.reduce((a, q) => a + q.err, 0) / s.length : NaN
    }
    r.driftMs = {
      firstHalf: half((q) => q.t < total / 2),
      secondHalf: half((q) => q.t >= total / 2)
    }
  }
  return r
}

/** ダッキング: 本編のビープの最中と、ビープから離れた所の BGM(連続音)の振幅の比 */
function checkDucking(
  e: Expect,
  x: Float32Array,
  pitch: number,
  from: number,
  to: number
): { duckedDb: number; restDb: number; tailDb: number; n: number } {
  const { mag, hop } = toneEnvelope(x, pitch)
  const at = (t: number): number =>
    mag[Math.min(mag.length - 1, Math.max(0, Math.round((t * 48000) / hop)))]
  const mains = e.beeps.filter(
    (b) => b.what.startsWith('main') && b.t > from + 0.5 && b.t < to - 0.7
  )
  const ducked: number[] = []
  const rest: number[] = []
  for (const b of mains) {
    ducked.push(at(b.t + 0.045))
    rest.push(at(b.t + 0.6))
  }
  const avg = (a: number[]): number => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
  return {
    duckedDb: 20 * Math.log10(avg(ducked) / 0.3),
    restDb: 20 * Math.log10(avg(rest) / 0.3),
    // 終わりの手前 0.25〜0.05 秒(本編のビープが無い所に置く)。下げていないので 0dB のはず
    tailDb:
      20 * Math.log10(avg([to - 0.25, to - 0.2, to - 0.15, to - 0.1, to - 0.05].map(at)) / 0.3),
    n: mains.length
  }
}

// ------------------------------------------------------------------ 実行

interface EngineResult {
  engine: string
  seconds: number
  probe: Probe
  video: VideoReport
  audio: AudioReport
  ducking?: ReturnType<typeof checkDucking>
  decoded: Decoded
}

async function runEngine(
  c: Case,
  engine: 'standard' | 'segmented' | 'segmented-small',
  layer: TelopLayerPayload | null
): Promise<EngineResult> {
  const project = buildProject(c)
  const out = join(work, 'out', `${c.name}.${engine}.mp4`)
  mkdirSync(join(work, 'out'), { recursive: true })
  rmSync(out, { force: true })
  const t0 = Date.now()
  if (engine === 'standard') {
    await exportProject({
      project,
      aspectRatio: '16:9',
      resolutionHeight: OUT_H,
      quality: 'high',
      outputPath: out,
      telopLayer: layer,
      onProgress: () => {}
    })
  } else {
    await exportSequenceSegmented({
      project: projectV1ToV2(project, { resolution: OUT_H }),
      outputPath: out,
      quality: 'high',
      encoder: 'libx264',
      telopLayer: layer,
      ...(engine === 'segmented-small' && c.segOptions ? { segmentOptions: c.segOptions } : {})
    })
  }
  const seconds = (Date.now() - t0) / 1000
  const e = expectedFor(c)
  const dbg = (m: string): void => {
    if (process.env.E2E_DEBUG)
      console.log(`[${c.name}/${engine}] ${m} ${process.memoryUsage().heapUsed >> 20}MB`)
  }
  dbg('exported')
  const decoded = await decodeVideo(out, e.totalFrames)
  dbg('decoded video')
  const audio = decodeAudioLeft(out)
  dbg('decoded audio')
  const probe = probeOut(out, e.fps)
  dbg('probed')
  const video = checkVideo(e, decoded)
  dbg('checked video')
  const audioRep = checkAudio(e, audio)
  dbg('checked audio')
  const res: EngineResult = { engine, seconds, probe, video, audio: audioRep, decoded }
  const duckTrack = (c.audio ?? []).find((t) => t.ducking)
  if (duckTrack) {
    const k = duckTrack.clips[0]
    res.ducking = checkDucking(
      e,
      audio,
      specByKey.get(k.src)!.pitch,
      k.start,
      k.start + k.out - k.in
    )
  }
  return res
}

function compareEngines(
  a: Decoded,
  b: Decoded
): { frames: number; mainDiff: number; pipDiff: number; telopDiff: number; firstDiff: number } {
  const n = Math.min(a.frames, b.frames)
  let mainDiff = 0
  let pipDiff = 0
  let telopDiff = 0
  let firstDiff = -1
  for (let k = 0; k < n; k++) {
    const m = a.mainId[k] !== b.mainId[k] || a.mainFrame[k] !== b.mainFrame[k]
    const p =
      a.pipConf[k] >= 40 !== b.pipConf[k] >= 40 ||
      (a.pipConf[k] >= 40 && a.pipFrame[k] !== b.pipFrame[k])
    const t = Math.abs(a.telopLum[k] - b.telopLum[k]) > 25
    if (m) mainDiff++
    if (p) pipDiff++
    if (t) telopDiff++
    if ((m || p || t) && firstDiff < 0) firstDiff = k
  }
  return { frames: n, mainDiff, pipDiff, telopDiff, firstDiff }
}

// ------------------------------------------------------------------ 企画の一覧

const MIXED30: Case = {
  name: 'mixed30',
  main: [
    { src: 'A30', in: 2.0, out: 5.0 },
    { src: 'B2997', in: 10.5, out: 14.5, speed: 2 },
    // 分割した後半を前へ並べ替え(前半は後ろ)
    { src: 'A30', in: 33.3, out: 36.0 },
    { src: 'A30', in: 20.0, out: 22.0, speed: 0.5 },
    { src: 'A30', in: 30.0, out: 33.3 },
    // 隣り合ったままの分割(境目は素材のフレームに乗らない)
    { src: 'B2997', in: 40.0, out: 42.2 },
    { src: 'B2997', in: 42.2, out: 44.0 }
  ],
  pip: [{ src: 'D60pip', start: 1.5, in: 3.0, out: 6.0 }],
  audio: [
    {
      volume: 1,
      clips: [{ src: 'Ebgm', start: 0.5, in: 1.25, out: 9.25, volume: 0.8, fadeIn: 1, fadeOut: 1 }]
    },
    { volume: 0.5, clips: [{ src: 'Fsfx', start: 7.31, in: 0, out: 3, volume: 1.5 }] }
  ],
  telops: [
    { start: 0, end: 1 },
    { start: 2.51, end: 2.95 },
    // 本編の境目(3.0秒)をまたぐ
    { start: 2.95, end: 3.6 },
    { start: 5.0, end: 6.0 },
    { start: 6.0, end: 7.0 },
    { start: 12.3, end: 13.3 },
    // 最後まで(本編の尺を越える分は切れる)
    { start: 17.5, end: 25 }
  ],
  segOptions: { targetFrames: 150, minFrames: 60, maxFrames: 240 }
}

const HFR60: Case = {
  name: 'hfr60',
  main: [
    { src: 'C60', in: 1.0, out: 4.0 },
    { src: 'C60', in: 6.5, out: 8.0, speed: 2 },
    { src: 'A30', in: 5.0, out: 7.0 },
    { src: 'C60', in: 10.0, out: 12.0, speed: 0.5 },
    { src: 'C60', in: 14.0, out: 16.0 }
  ],
  pip: [{ src: 'D60pip', start: 2.0, in: 0.5, out: 3.5 }],
  audio: [{ volume: 1, ducking: true, clips: [{ src: 'Gtone', start: 0, in: 0, out: 10.6 }] }],
  telops: [
    { start: 0.5, end: 1.25 },
    { start: 3.0, end: 3.3 },
    { start: 7.0, end: 9.0 }
  ],
  segOptions: { targetFrames: 240, minFrames: 120, maxFrames: 400 }
}

const NTSC2997: Case = {
  name: 'ntsc2997',
  main: [
    { src: 'B2997', in: 0, out: 5.0 },
    { src: 'B2997', in: 7.3, out: 9.1 },
    { src: 'B2997', in: 20, out: 50 }
  ],
  audio: [{ volume: 1, clips: [{ src: 'Fsfx', start: 3.2, in: 0, out: 5 }] }],
  telops: [
    { start: 4.9, end: 5.1 },
    { start: 30, end: 31 }
  ]
}

function longCase(): Case {
  const main: MainSpec[] = []
  let t = 0
  let i = 0
  while (t < 600) {
    const speed = i % 7 === 3 ? 2 : i % 11 === 5 ? 0.5 : 1
    const src = i % 3 === 2 ? 'B2997' : 'A30'
    const tlDur = Math.min(600 - t, 14.9 + (i % 5) * 0.0137)
    const srcDur = tlDur * speed
    const inP = ((i * 7.31) % (68 - srcDur)) + 0.123
    main.push({ src, in: Number(inP.toFixed(4)), out: Number((inP + srcDur).toFixed(4)), speed })
    t += tlDur
    i++
    if (tlDur < 1) break
  }
  const telops: TelopSpec[] = []
  for (let k = 0; k < 299; k++) {
    const start = 2 * k + 0.5 + (k % 7) * 0.0071
    telops.push({ start, end: start + 1 + (k % 5) * 0.013 })
  }
  return {
    name: 'long10min',
    main,
    pip: [
      { src: 'D60pip', start: 100.37, in: 1, out: 4 },
      { src: 'D60pip', start: 590.11, in: 5, out: 8 }
    ],
    audio: [
      {
        volume: 1,
        clips: [
          { src: 'Fsfx', start: 50.37, in: 0, out: 3 },
          { src: 'Fsfx', start: 300.11, in: 0, out: 3 },
          { src: 'Fsfx', start: 595.5, in: 0, out: 3 }
        ]
      }
    ],
    telops
  }
}

// ------------------------------------------------------------------ テスト

/**
 * 端の値(再監査で見つかった所): 頭が素材の 0.25 秒 + 丸めの残り(`-ss` に指数で書くと読めず失敗した)、
 * 素材の頭のすぐ近くから読むクリップ、フレームの間から読むワイプ(頭の1コマが次の絵になっていた)
 */
const EDGES: Case = {
  name: 'edges',
  main: [
    { src: 'A30', in: 0.55 - 0.3, out: 2.0 },
    { src: 'A30', in: 0.1, out: 1.5 },
    { src: 'A30', in: 3.01, out: 5.0 }
  ],
  pip: [{ src: 'D60pip', start: 0.5, in: 3.012, out: 4.5 }],
  telops: [{ start: 0.2, end: 1.0 }]
}

const CASES: Case[] = FULL ? [MIXED30, HFR60, EDGES, NTSC2997, longCase()] : [MIXED30, HFR60, EDGES]
const report: Record<string, unknown> = {}

function summarize(r: EngineResult): Record<string, unknown> {
  const { decoded: _d, ...rest } = r
  void _d
  return {
    ...rest,
    video: {
      ...r.video,
      mainWrongSource: {
        count: r.video.mainWrongSource.length,
        first: r.video.mainWrongSource.slice(0, 20)
      },
      pipWrongPresence: {
        count: r.video.pipWrongPresence.length,
        list: r.video.pipWrongPresence.slice(0, 20)
      },
      telopWrong: { count: r.video.telopWrong.length, list: r.video.telopWrong.slice(0, 40) },
      telopEdges: r.video.telopEdges
        .filter((q) => q.firstSeen !== q.start || q.lastSeen !== q.end - 1)
        .slice(0, 40),
      telopEdgesTotal: r.video.telopEdges.length
    },
    audio: {
      ...r.audio,
      unexpected: r.audio.unexpected.slice(0, 20),
      unexpectedCount: r.audio.unexpected.length
    }
  }
}

describe.skipIf(!HAVE_FFMPEG)('書き出しの受け入れ試験(実際の ffmpeg)', () => {
  beforeAll(async () => {
    work = KEEP_DIR ?? mkdtempSync(join(tmpdir(), 've-e2e-export-'))
    mkdirSync(work, { recursive: true })
    const needed = new Set(
      CASES.flatMap((c) => [
        ...c.main.map((m) => m.src),
        ...(c.pip ?? []).map((p) => p.src),
        ...(c.audio ?? []).flatMap((t) => t.clips.map((k) => k.src))
      ])
    )
    await Promise.all(
      SOURCES.filter((s) => needed.has(s.key)).map(async (s) =>
        assets.set(s.key, await makeSource(s))
      )
    )
  }, 120_000)

  afterAll(() => {
    if (KEEP_DIR) writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2))
    else if (work) rmSync(work, { recursive: true, force: true })
  })

  it('計器の確認: 素材をそのまま読むと、絵の番号と音の時刻が書き込んだとおりに出る', async () => {
    // 素材を書き出しと同じ大きさへ拡大しただけのもの(書き出しのコードは通さない)
    const a = assets.get('A30')!
    const out = join(work, 'control.mp4')
    ff([
      '-ss',
      '2',
      '-t',
      '3',
      '-i',
      a.filePath,
      '-vf',
      `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '18',
      '-c:a',
      'aac',
      out
    ])
    const d = await decodeVideo(out, 90)
    expect(d.frames).toBe(90)
    for (let k = 0; k < 90; k++) {
      expect(d.mainId[k]).toBe(1)
      expect(d.mainFrame[k]).toBe(60 + k)
    }
    const on = detectOnsets(decodeAudioLeft(out), 500)
    for (const [i, o] of on.entries()) expect(Math.abs(o.t - i)).toBeLessThan(0.004)
    expect(on).toHaveLength(3)
  }, 60_000)

  for (const c of CASES) {
    it(
      `${c.name}: 標準と区間分割の両方で、尺・絵・テロップ・ワイプ・音が期待どおり`,
      async () => {
        const e = expectedFor(c)
        const project = buildProject(c)
        const layer = telopLayerFor(project)
        const engines: ('standard' | 'segmented' | 'segmented-small')[] = ['standard', 'segmented']
        if (c.segOptions) engines.push('segmented-small')
        const results: EngineResult[] = []
        for (const eng of engines) results.push(await runEngine(c, eng, layer))
        const cmp = results.slice(1).map((r) => ({
          engines: `standard vs ${r.engine}`,
          ...compareEngines(results[0].decoded, r.decoded)
        }))
        report[c.name] = {
          fps: e.fps,
          expectedFrames: e.totalFrames,
          expectedSeconds: e.totalFrames / e.fps,
          engines: results.map(summarize),
          compare: cmp
        }
        const frame = 1 / e.fps
        const oneFrameMs = 1000 / e.fps
        for (const r of results) {
          const tag = `${c.name}/${r.engine}`
          // 尺
          expect.soft(r.video.decodedFrames, `${tag} フレーム数`).toBe(e.totalFrames)
          expect
            .soft(Math.abs(r.probe.formatDuration - e.totalFrames / e.fps), `${tag} 尺`)
            .toBeLessThanOrEqual(frame + 1e-3)
          expect
            .soft(Math.abs(r.audio.samples / 48000 - e.totalFrames / e.fps), `${tag} 音の尺`)
            .toBeLessThanOrEqual(frame)
          expect.soft(r.probe.ptsIrregular, `${tag} 時刻の刻み`).toBe(0)
          // 絵
          expect.soft(r.video.mainWrongSource.length, `${tag} 違う素材が出たフレーム`).toBe(0)
          // 【直した穴】区間の境目がスロー(速度<1)のクリップの途中に来ると、素材のフレームの途中から読み始めて
          // 1枚ぶん早く進む(segmentGraph.ts の addMediaInput の seek)
          if (STRICT || r.engine !== 'segmented-small') {
            expect
              .soft(r.video.mainExactViolations, `${tag} ぴったりのはずの所でずれたフレーム`)
              .toBe(0)
          }
          // 絵の時刻: 出ている素材のフレームは、その時刻を含むフレーム(先へ進むのは丸めの半フレームまで)。
          // 【直した穴】イン点が素材のフレームの途中(29.97fps の素材では常に)だと、最初の1枚が fps の格子の
          // 1枚目に乗り、`setpts=N` で1フレーム前へ詰められて、絵が音より最大 1.5 フレーム先に進む
          expect
            .soft(r.video.mainLeadMs.max, `${tag} 本編の絵が先に進んでいる(ms)`)
            .toBeLessThanOrEqual((STRICT ? 0.5 : 1.5) * oneFrameMs + 0.5)
          expect
            .soft(r.video.mainLeadMs.min, `${tag} 本編の絵が遅れている(ms)`)
            .toBeGreaterThanOrEqual(-oneFrameMs - 0.5)
          if (e.pip.length) {
            expect
              .soft(r.video.pipLeadMs.max, `${tag} ワイプの絵が先に進んでいる(ms)`)
              .toBeLessThanOrEqual(0.5 * oneFrameMs + 0.5)
            expect
              .soft(r.video.pipLeadMs.min, `${tag} ワイプの絵が遅れている(ms)`)
              .toBeGreaterThanOrEqual(-oneFrameMs - 0.5)
          }
          // 【直した穴】標準の書き出しのワイプは `between(t, 始まり, 終わり)` が終わりを含み、始まりも丸めないので、
          // 1本につき最大2フレーム(終わりの1枚が余分・始まりが1枚遅れ)違う
          expect
            .soft(r.video.pipWrongPresence.length, `${tag} ワイプの出入りが違うフレーム`)
            .toBeLessThanOrEqual(STRICT || r.engine !== 'standard' ? 0 : 2 * e.pip.length)
          expect.soft(r.video.telopWrong.length, `${tag} テロップが違うフレーム`).toBe(0)
          // 音
          expect.soft(r.audio.missing.length, `${tag} 鳴らなかったビープ`).toBe(0)
          expect.soft(r.audio.unexpected.length, `${tag} 余計なビープ`).toBe(0)
          expect
            .soft(
              Math.max(Math.abs(r.audio.normalErrMs.min), Math.abs(r.audio.normalErrMs.max)),
              `${tag} ビープの時刻のずれ(ms)`
            )
            .toBeLessThanOrEqual(oneFrameMs)
          // スロー(atempo で伸ばした音)は、純音のビープの頭が 40ms 前後早く出る(WSOLA が似た波形を
          // 手前から写すため。純音で目立つ性質)。話し声に近い音で包絡を比べると 2〜11ms で、
          // 口の動きと音のずれが気付かれる境(音が先行 45ms、ITU-R BT.1359)より十分小さい。
          // ビープでは境の 45ms を上限にする
          if (r.audio.slowErrMs.min <= r.audio.slowErrMs.max) {
            expect
              .soft(
                Math.max(Math.abs(r.audio.slowErrMs.min), Math.abs(r.audio.slowErrMs.max)),
                `${tag} スローのビープの時刻のずれ(ms)`
              )
              .toBeLessThanOrEqual(45)
          }
          expect.soft(r.audio.ampWorst.length, `${tag} 音量が 1.5dB 以上違うビープ`).toBe(0)
          if (r.ducking) {
            expect
              .soft(r.ducking.duckedDb - r.ducking.restDb, `${tag} ダッキングで下がる`)
              .toBeLessThan(-3)
            // 【直した穴】標準の書き出しは、ダッキングする BGM の後ろが運次第で消える(下の専用の試験で確かめる)
            if (STRICT || r.engine !== 'standard') {
              expect
                .soft(r.ducking.tailDb, `${tag} ダッキングする BGM の終わりまで鳴る`)
                .toBeGreaterThan(-3)
            }
          }
        }
        for (const q of cmp) {
          expect.soft(q.telopDiff, `${c.name} ${q.engines} でテロップが違うフレーム`).toBe(0)
          if (STRICT || q.engines !== 'standard vs segmented-small') {
            expect.soft(q.mainDiff, `${c.name} ${q.engines} で本編の絵が違うフレーム`).toBe(0)
          }
          // ワイプは標準の側の既知の穴(上)のぶん違う
          if (STRICT)
            expect.soft(q.pipDiff, `${c.name} ${q.engines} でワイプが違うフレーム`).toBe(0)
        }
      },
      FULL ? 1_800_000 : 120_000
    )
  }

  /**
   * 【直した穴】標準の書き出しで、ダッキングする BGM の**終わりの手前が運次第で消える**。
   * `sidechaincompress` の主入力(BGM)が先に終わると、検出側(本編の音)を待っていた分が捨てられる。
   * BGM は速く読めるので、どれだけ先に読んでいたかで消える長さが変わる(実測: 0〜0.86秒)。
   * 区間分割の書き出しは、BGM を区間の長さちょうどに伸ばしてから掛けるので起きない。
   */
  it('ダッキングする BGM が終わりまで鳴る(標準・区間分割を4回ずつ。本編の途中で終わる BGM と、本編の終わりまで続く BGM)', async () => {
    for (const bgmEnd of [4, 5]) {
      const c: Case = {
        name: 'duckTail',
        main: [
          { src: 'C60', in: 1, out: 4 },
          { src: 'C60', in: 14, out: 16 }
        ],
        audio: [
          { volume: 1, ducking: true, clips: [{ src: 'Gtone', start: 0, in: 0, out: bgmEnd }] }
        ]
      }
      const project = buildProject(c)
      const ends: Record<string, number[]> = { standard: [], segmented: [] }
      for (let i = 0; i < 4; i++) {
        for (const engine of ['standard', 'segmented'] as const) {
          const out = join(work, 'out', `duckTail.${engine}.${i}.mp4`)
          mkdirSync(join(work, 'out'), { recursive: true })
          if (engine === 'standard') {
            await exportProject({
              project,
              aspectRatio: '16:9',
              resolutionHeight: OUT_H,
              quality: 'standard',
              outputPath: out,
              telopLayer: null,
              onProgress: () => {}
            })
          } else {
            await exportSequenceSegmented({
              project: projectV1ToV2(project, { resolution: OUT_H }),
              outputPath: out,
              quality: 'standard',
              encoder: 'libx264',
              telopLayer: null
            })
          }
          const { mag, hop } = toneEnvelope(decodeAudioLeft(out), 3500)
          let last = 0
          for (let k = 0; k < mag.length; k++) if (mag[k] > 0.05) last = k
          ends[engine].push(Number(((last * hop) / 48000).toFixed(3)))
        }
      }
      report[`duckTail${bgmEnd}`] = ends
      // 窓が後ろ向き 10ms なので、終わりは BGM の終わり + 10ms 弱で見える(本編の終わり 5 秒で切れる)
      for (const t of ends.segmented)
        expect.soft(t, `区間分割の BGM の終わり(${bgmEnd})`).toBeGreaterThan(bgmEnd - 0.03)
      for (const t of ends.standard)
        expect.soft(t, `標準の BGM の終わり(${bgmEnd})`).toBeGreaterThan(bgmEnd - 0.03)
    }
  }, 240_000)
})

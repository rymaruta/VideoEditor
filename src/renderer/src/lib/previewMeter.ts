import { audibleGainOf, getSharedAudioContext } from './previewAudio'
import { peakOf } from './meterMath'

/**
 * プログラムの音量計の測り口。**再生の経路には触らない。**
 *
 * 各要素(本編・ワイプの `<video>`、音声トラックの `<audio>`)の音を `captureStream()` で
 * 写し取り、要素ごとの `GainNode` で「いま聞こえている倍率」(試聴の音量・トラック音量・
 * フェード・ダッキング・ミュート・ソロ)を掛けて 1 本に足し、L/R に分けて測る。
 * 測るだけの枝なので出力(スピーカー)には繋がない。
 *
 * 実測(Electron): `captureStream()` の音は要素の `volume`・`muted` を掛ける**前**の音で、
 * `createMediaElementSource` で付け替えた要素からも取れる。だから倍率はここで掛け直す
 * (`audibleGainOf`)。`createMediaElementSource` と違って何度でも呼べ、失敗しても音は消えない。
 */

interface Tap {
  stream: MediaStream
  trackId: string | null
  source: MediaStreamAudioSourceNode | null
  gain: GainNode
}

interface Bus {
  input: GainNode
  left: AnalyserNode
  right: AnalyserNode
  bufL: Float32Array<ArrayBuffer>
  bufR: Float32Array<ArrayBuffer>
}

const FFT = 1024
let bus: Bus | null = null
const taps = new Map<HTMLMediaElement, Tap>()

function ensureBus(): Bus | null {
  if (bus) return bus
  const ctx = getSharedAudioContext()
  if (!ctx) return null
  try {
    const input = ctx.createGain()
    // 1ch の素材は L/R の両方へ(話し声の 1ch 収録で右だけ振れないことのないように)
    input.channelCount = 2
    input.channelCountMode = 'explicit'
    input.channelInterpretation = 'speakers'
    const split = ctx.createChannelSplitter(2)
    const left = ctx.createAnalyser()
    const right = ctx.createAnalyser()
    left.fftSize = FFT
    right.fftSize = FFT
    input.connect(split)
    split.connect(left, 0)
    split.connect(right, 1)
    bus = {
      input,
      left,
      right,
      bufL: new Float32Array(new ArrayBuffer(FFT * 4)),
      bufR: new Float32Array(new ArrayBuffer(FFT * 4))
    }
    return bus
  } catch {
    return null
  }
}

type CapturableElement = HTMLMediaElement & { captureStream?: () => MediaStream }

/** 要素の音の写しを作る(まだなら)。聞こえていない要素(常に消音の重ね・控え)は写さない */
function ensureTap(el: HTMLMediaElement, b: Bus, ctx: AudioContext): Tap | null {
  const existing = taps.get(el)
  if (existing) return existing
  const capture = (el as CapturableElement).captureStream
  if (typeof capture !== 'function') return null
  try {
    const stream = capture.call(el)
    // 絵の写しは使わない(取り続けると重い)
    stream.getVideoTracks().forEach((t) => t.stop())
    stream.addEventListener('addtrack', (e) => {
      const t = (e as MediaStreamTrackEvent).track
      if (t.kind === 'video') t.stop()
    })
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(b.input)
    const tap: Tap = { stream, trackId: null, source: null, gain }
    taps.set(el, tap)
    return tap
  } catch {
    return null
  }
}

/** 素材が替わると音のトラックも替わるので、繋ぎ直す */
function syncTapSource(tap: Tap, ctx: AudioContext): void {
  const track = tap.stream.getAudioTracks().find((t) => t.readyState === 'live') ?? null
  const id = track?.id ?? null
  if (id === tap.trackId) return
  tap.source?.disconnect()
  // 前の素材の写しのトラックは止める(残すと写しが裏で回り続ける)
  tap.stream.getAudioTracks().forEach((t) => {
    if (t !== track) t.stop()
  })
  tap.source = null
  tap.trackId = id
  if (!track) return
  try {
    tap.source = ctx.createMediaStreamSource(new MediaStream([track]))
    tap.source.connect(tap.gain)
  } catch {
    tap.source = null
  }
}

function dropTap(el: HTMLMediaElement, tap: Tap): void {
  tap.source?.disconnect()
  tap.stream.getTracks().forEach((t) => t.stop())
  tap.gain.disconnect()
  taps.delete(el)
}

/**
 * いまの L/R のピーク(振幅。1 = 0 dBFS)。測れないときは null。
 * `root` の中の `<video>`・`<audio>` を毎回見直す(生えた・消えた・入れ替わった要素に追従する)
 */
export function readProgramPeaks(root: ParentNode): { left: number; right: number } | null {
  const ctx = getSharedAudioContext()
  if (!ctx) return null
  const b = ensureBus()
  if (!b) return null
  const present = new Set<HTMLMediaElement>()
  root.querySelectorAll<HTMLMediaElement>('video, audio').forEach((el) => {
    present.add(el)
    const g = audibleGainOf(el)
    const tap = g > 0 ? ensureTap(el, b, ctx) : (taps.get(el) ?? null)
    if (!tap) return
    syncTapSource(tap, ctx)
    tap.gain.gain.value = g
  })
  taps.forEach((tap, el) => {
    if (!present.has(el)) dropTap(el, tap)
  })
  b.left.getFloatTimeDomainData(b.bufL)
  b.right.getFloatTimeDomainData(b.bufR)
  return { left: peakOf(b.bufL), right: peakOf(b.bufR) }
}

/** 音量計を外したとき: 写しを全部やめる */
export function releaseProgramMeter(): void {
  taps.forEach((tap, el) => dropTap(el, tap))
}

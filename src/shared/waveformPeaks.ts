/**
 * タイムラインの細かい波形のデータ。ffmpeg が流す生の音(f32le・交互に並んだ L/R)を、
 * **流しながら**列ごとに集計する(全部を配列に溜めない。3 時間の素材でも、持つのは列の数ぶんだけ)。
 *
 * 列ごとに、符号付きの最大・最小(山の上側と下側。上下は非対称のまま)と RMS(内側の平均)を持つ。
 * 値は -1〜1(フルスケール)。持ち上げ(平方根)は描く側で掛ける。
 */

/** 1 本の音(チャンネル)の列ごとの値 */
export interface WavePeakChannel {
  max: Float32Array
  min: Float32Array
  rms: Float32Array
}

export interface WavePeaks {
  /** 形の版。描く側が知らない版なら使わない(画像の波形へ戻る) */
  version: typeof WAVE_PEAKS_VERSION
  columns: number
  /** 1 (モノラル) か 2 (L/R) */
  channels: WavePeakChannel[]
}

export const WAVE_PEAKS_VERSION = 1

/** 素の値・細かい読み直しで音を読む速さ(Hz) */
export const WAVE_READ_RATE = 16000

/** 1 回に頼める列の上限(canvas の上限と同じ。超える分は main が切り詰める) */
export const WAVE_PEAKS_MAX_COLUMNS = 65535

/** 生の音を読む速さ。1 列に数サンプル以上入るように上げ、上限は 48kHz */
export function peakSampleRate(columns: number, durationSec: number): number {
  const need = Math.ceil((Math.max(1, columns) * 8) / Math.max(0.05, durationSec))
  // 下限は 16kHz(8kHz に落とすと 4kHz を越える音が消える。長い素材は素の値を 1 回だけ作るので時間は問題にならない)
  return Math.min(48000, Math.max(WAVE_READ_RATE, need))
}

/**
 * 流れてくる音を列ごとに集計する。`totalFrames` は区間の長さ×速さ(ffmpeg は区間の長さまで
 * 無音で埋めて流すので、ほぼこの数が来る。溢れた分は最後の列、足りない分は無音のまま)
 */
export class WavePeakAccumulator {
  private readonly ch: number
  private readonly cols: number
  private readonly frames: number
  private readonly max: Float32Array[]
  private readonly min: Float32Array[]
  private readonly sumSq: Float64Array[]
  private readonly count: Uint32Array
  /** 次に来るサンプルの通し番号(L/R をまたいで数える。チャンク境目でフレームが割れても合う) */
  private sampleIndex = 0

  constructor(columns: number, channels: number, totalFrames: number) {
    this.cols = Math.max(1, Math.min(WAVE_PEAKS_MAX_COLUMNS, Math.round(columns)))
    this.ch = Math.max(1, Math.round(channels))
    this.frames = Math.max(1, Math.round(totalFrames))
    this.max = Array.from({ length: this.ch }, () => new Float32Array(this.cols))
    this.min = Array.from({ length: this.ch }, () => new Float32Array(this.cols))
    this.sumSq = Array.from({ length: this.ch }, () => new Float64Array(this.cols))
    this.count = new Uint32Array(this.cols)
  }

  /** 交互に並んだサンプル(L, R, L, R, …)を足す */
  push(samples: ArrayLike<number>): void {
    const ch = this.ch
    const cols = this.cols
    const frames = this.frames
    let idx = this.sampleIndex
    for (let i = 0; i < samples.length; i++, idx++) {
      const c = idx % ch
      const frame = (idx - c) / ch
      let col = Math.floor((frame * cols) / frames)
      if (col >= cols) col = cols - 1
      let v = samples[i]
      if (!(v === v)) v = 0 // NaN は無音として数える
      if (v > this.max[c][col]) this.max[c][col] = v
      if (v < this.min[c][col]) this.min[c][col] = v
      this.sumSq[c][col] += v * v
      if (c === 0) this.count[col]++
    }
    this.sampleIndex = idx
  }

  finish(): WavePeaks {
    const channels: WavePeakChannel[] = []
    for (let c = 0; c < this.ch; c++) {
      const rms = new Float32Array(this.cols)
      for (let k = 0; k < this.cols; k++) {
        const n = this.count[k]
        rms[k] = n > 0 ? Math.sqrt(this.sumSq[c][k] / n) : 0
      }
      channels.push({ max: this.max[c], min: this.min[c], rms })
    }
    return { version: WAVE_PEAKS_VERSION, columns: this.cols, channels }
  }
}

/** 覚えておく大きさ(バイト)。キャッシュの上限を数えるのに使う */
export function wavePeaksBytes(p: WavePeaks): number {
  return p.channels.length * p.columns * 3 * 4
}

/** 届いた値が今の形か(IPC の向こうから来るので確かめてから使う) */
export function isWavePeaks(v: unknown): v is WavePeaks {
  if (!v || typeof v !== 'object') return false
  const p = v as Partial<WavePeaks>
  if (p.version !== WAVE_PEAKS_VERSION || typeof p.columns !== 'number' || p.columns < 1)
    return false
  if (!Array.isArray(p.channels) || p.channels.length < 1 || p.channels.length > 2) return false
  return p.channels.every(
    (c) =>
      c &&
      c.max instanceof Float32Array &&
      c.min instanceof Float32Array &&
      c.rms instanceof Float32Array &&
      c.max.length === p.columns &&
      c.min.length === p.columns &&
      c.rms.length === p.columns
  )
}

/** preload が出す関数の形(renderer・main・試験で同じ型を見る) */
export type GenerateWaveformPeaks = (
  filePath: string,
  rangeStart: number,
  rangeEnd: number,
  columns: number,
  /** 止めるときの番号(`CancelWaveformPeaks` に渡す) */
  requestId?: string
) => Promise<WavePeaks>

/** 頼みを止める(止めた頼みは `PCM_ABORTED` を含む失敗で返る) */
export type CancelWaveformPeaks = (requestId: string) => Promise<void>

/** 止めた頼みの失敗に入る文字(main の `PCM_ABORTED` と同じ) */
export const WAVE_PEAKS_ABORTED = 'PCM_ABORTED'

// ---------------------------------------------------------------------------
// 素材ごとの「素の値」: 一定の細かさ(1 秒 100 列)の最大・最小・RMS を、素材ごとに 1 回だけ作って
// ディスクに覚える。拡大・トリムでは ffmpeg を起こさず、ここから頼まれた範囲・列数に集計して返す。
// 大きさ: 1 列 × 1ch あたり 3 値 × 2 バイト。3 時間・ステレオで 10800×100×2×6 ≒ 13MB(モノラルはその半分)。
// ---------------------------------------------------------------------------

/** 素の値の細かさ(1 秒あたりの列)。これより細かく頼まれたら(拡大 125% 超)、見えている所だけ読み直す */
export const WAVE_BASE_RATE = 100

/** 素の値のファイルの形の版(変えたら上げる。古い形は作り直す) */
export const WAVE_BASE_VERSION = 1

/**
 * どの音を描くか。`both` は L/R の 2 段、0 / 1 はその 1 本だけ(モノラル・左右が同じ・片方がほぼ無音)
 */
export type WaveChannelPick = 'both' | 0 | 1

export interface WaveBase {
  rate: number
  /** 読んだ音の本数(1 か 2) */
  sourceChannels: number
  pick: WaveChannelPick
  columns: number
  /** 列ごと・描く音ごとに [最大, 最小, RMS] を ±32767 で(描く音が 2 本なら 1 列 6 値) */
  data: Int16Array
}

const Q = 32767
const q = (v: number): number => Math.max(-Q, Math.min(Q, Math.round(v * Q)))

/** 描く音の本数 */
export function pickedChannels(pick: WaveChannelPick): number {
  return pick === 'both' ? 2 : 1
}

/**
 * 左右をどう描くかを、音全体の大きさから決める。左右がほぼ同じ(モノラルを 2ch にしたもの)・
 * 片方がほぼ無音なら 1 段で描く(同じ波形が 2 段・片方が平らな線になっていた)
 */
export function decideChannelPick(
  sourceChannels: number,
  energyL: number,
  energyR: number,
  energyDiff: number
): WaveChannelPick {
  if (sourceChannels < 2) return 0
  const total = energyL + energyR
  if (total <= 0) return 0
  if (energyDiff <= 1e-4 * total) return 0
  if (energyR < 1e-3 * energyL) return 0
  if (energyL < 1e-3 * energyR) return 1
  return 'both'
}

/**
 * 流れてくる音(交互に並んだ L/R、または 1ch)から素の値を作る。長さは知らなくてよい
 * (届いた分だけ列が伸びる)。持つのは列の数ぶんだけ
 */
export class WaveBaseBuilder {
  private readonly perCol: number
  private max: Float32Array[]
  private min: Float32Array[]
  private sumSq: Float64Array[]
  private cols = 0
  private cap = 4096
  private sampleIndex = 0
  private frameInCol = 0
  private energyL = 0
  private energyR = 0
  private energyDiff = 0
  private pendingL = 0

  constructor(
    sampleRate: number,
    private readonly ch: number,
    private readonly rate: number = WAVE_BASE_RATE
  ) {
    this.perCol = Math.max(1, Math.round(sampleRate / rate))
    this.max = Array.from({ length: ch }, () => new Float32Array(this.cap))
    this.min = Array.from({ length: ch }, () => new Float32Array(this.cap))
    this.sumSq = Array.from({ length: ch }, () => new Float64Array(this.cap))
  }

  private grow(): void {
    const cap = this.cap * 2
    const g32 = (a: Float32Array): Float32Array => {
      const b = new Float32Array(cap)
      b.set(a)
      return b
    }
    const g64 = (a: Float64Array): Float64Array => {
      const b = new Float64Array(cap)
      b.set(a)
      return b
    }
    this.max = this.max.map(g32)
    this.min = this.min.map(g32)
    this.sumSq = this.sumSq.map(g64)
    this.cap = cap
  }

  push(samples: ArrayLike<number>): void {
    const ch = this.ch
    for (let i = 0; i < samples.length; i++) {
      const c = this.sampleIndex % ch
      this.sampleIndex++
      let v = samples[i]
      if (!(v === v)) v = 0
      if (c === 0 && this.frameInCol === 0) {
        if (this.cols >= this.cap) this.grow()
        this.cols++
      }
      const col = this.cols - 1
      if (v > this.max[c][col]) this.max[c][col] = v
      if (v < this.min[c][col]) this.min[c][col] = v
      this.sumSq[c][col] += v * v
      if (ch === 2) {
        if (c === 0) {
          this.pendingL = v
          this.energyL += v * v
        } else {
          this.energyR += v * v
          const d = this.pendingL - v
          this.energyDiff += d * d
        }
      }
      if (c === ch - 1) {
        this.frameInCol++
        if (this.frameInCol >= this.perCol) this.frameInCol = 0
      }
    }
  }

  finish(): WaveBase {
    const pick = decideChannelPick(this.ch, this.energyL, this.energyR, this.energyDiff)
    const use = pick === 'both' ? [0, 1] : [pick]
    const n = use.length
    const data = new Int16Array(this.cols * n * 3)
    for (let k = 0; k < this.cols; k++) {
      // 最後の列は途中までのことがある(数えた数で割る)
      const frames = k === this.cols - 1 && this.frameInCol > 0 ? this.frameInCol : this.perCol
      use.forEach((c, j) => {
        const o = (k * n + j) * 3
        data[o] = q(this.max[c][k])
        data[o + 1] = q(this.min[c][k])
        data[o + 2] = q(Math.sqrt(this.sumSq[c][k] / frames))
      })
    }
    return { rate: this.rate, sourceChannels: this.ch, pick, columns: this.cols, data }
  }
}

/**
 * 素の値から、素材の `start`〜`end` 秒を `columns` 列に集計する(1 列に素の列が 1 つ以上入る細かさまで)。
 * 素材の終わりより後は無音(画像の波形と同じく区間の長さまで埋める)
 */
export function aggregateBase(
  base: WaveBase,
  start: number,
  end: number,
  columns: number
): WavePeaks {
  const cols = Math.max(1, Math.min(WAVE_PEAKS_MAX_COLUMNS, Math.round(columns)))
  const n = pickedChannels(base.pick)
  const out: WavePeakChannel[] = Array.from({ length: n }, () => ({
    max: new Float32Array(cols),
    min: new Float32Array(cols),
    rms: new Float32Array(cols)
  }))
  const span = Math.max(1e-6, end - start)
  for (let k = 0; k < cols; k++) {
    const t0 = start + (span * k) / cols
    const t1 = start + (span * (k + 1)) / cols
    // 端の小さな誤差で隣の列まで入れない(0.54 秒 × 100 が 54.0000001 になって 55 列目まで数えていた)
    const a = Math.max(0, Math.floor(t0 * base.rate + 1e-6))
    const b = Math.min(base.columns, Math.max(a + 1, Math.ceil(t1 * base.rate - 1e-6)))
    for (let j = 0; j < n; j++) {
      let mx = 0
      let mn = 0
      let ss = 0
      let cnt = 0
      for (let i = a; i < b; i++) {
        const o = (i * n + j) * 3
        const vmax = base.data[o] / Q
        const vmin = base.data[o + 1] / Q
        const vr = base.data[o + 2] / Q
        if (vmax > mx) mx = vmax
        if (vmin < mn) mn = vmin
        ss += vr * vr
        cnt++
      }
      out[j].max[k] = mx
      out[j].min[k] = mn
      out[j].rms[k] = cnt > 0 ? Math.sqrt(ss / cnt) : 0
    }
  }
  return { version: WAVE_PEAKS_VERSION, columns: cols, channels: out }
}

/** 細かく読み直した値(読んだ音の本数ぶん)を、素の値と同じ描き方(1 段 / 2 段)にそろえる */
export function applyChannelPick(peaks: WavePeaks, pick: WaveChannelPick): WavePeaks {
  if (pick === 'both' || peaks.channels.length < 2) return peaks
  return { ...peaks, channels: [peaks.channels[pick]] }
}

/** 頼まれた細かさ(1 秒あたりの列)が素の値で足りるか */
export function baseIsFineEnough(
  start: number,
  end: number,
  columns: number,
  rate: number = WAVE_BASE_RATE
): boolean {
  return columns / Math.max(1e-6, end - start) <= rate + 1e-9
}

const MAGIC = 0x4b505756 // 'VWPK'

/** ディスクに書く形: [MAGIC, 版, rate, sourceChannels, pick(0/1/2=both), columns] の u32 と Int16 の値 */
export function encodeWaveBase(base: WaveBase): Uint8Array {
  const head = new Uint32Array([
    MAGIC,
    WAVE_BASE_VERSION,
    base.rate,
    base.sourceChannels,
    base.pick === 'both' ? 2 : base.pick,
    base.columns
  ])
  const out = new Uint8Array(head.byteLength + base.data.byteLength)
  out.set(new Uint8Array(head.buffer), 0)
  out.set(
    new Uint8Array(base.data.buffer, base.data.byteOffset, base.data.byteLength),
    head.byteLength
  )
  return out
}

/** 読めない・形が違う・版が古い・壊れている(長さが合わない)なら null */
export function decodeWaveBase(bytes: Uint8Array): WaveBase | null {
  if (bytes.byteLength < 24) return null
  const head = new Uint32Array(bytes.slice(0, 24).buffer)
  if (head[0] !== MAGIC || head[1] !== WAVE_BASE_VERSION) return null
  const pickNum = head[4]
  if (pickNum > 2) return null
  const pick: WaveChannelPick = pickNum === 2 ? 'both' : (pickNum as 0 | 1)
  const columns = head[5]
  const len = columns * pickedChannels(pick) * 3
  if (bytes.byteLength !== 24 + len * 2) return null
  const data = new Int16Array(bytes.slice(24).buffer)
  return { rate: head[2], sourceChannels: head[3], pick, columns, data }
}

export function waveBaseBytes(base: WaveBase): number {
  return base.data.byteLength
}

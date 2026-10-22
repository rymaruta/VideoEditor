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

/** 1 回に頼める列の上限(canvas の上限と同じ。超える分は main が切り詰める) */
export const WAVE_PEAKS_MAX_COLUMNS = 65535

/** 生の音を読む速さ。1 列に数サンプル以上入るように上げ、上限は 48kHz */
export function peakSampleRate(columns: number, durationSec: number): number {
  const need = Math.ceil((Math.max(1, columns) * 8) / Math.max(0.05, durationSec))
  // 長い区間(10 分超)は 8kHz で読む(3 時間で main の集計が数秒かからないように。山の見え方はほぼ同じ)
  const floor = durationSec > 600 ? 8000 : 16000
  return Math.min(48000, Math.max(floor, need))
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
  columns: number
) => Promise<WavePeaks>

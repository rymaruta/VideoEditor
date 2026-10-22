/**
 * 波形を二重(外側に山・内側に平均)に描くための純関数。
 *
 * **canvas は一定幅のタイルに分けて描く。** Chromium の canvas は一辺が 65,535px を超えると
 * 例外も出さずに何も描かない(拡大率 1 で約 27 分、最大拡大で約 6.8 分を超えるクリップの
 * 波形が丸ごと消えていた)。タイルにすれば、どんなに長いクリップでも一枚は上限を超えない。
 * 描くのは画面に見えているタイルだけにして、長い素材をズーム・トリムしても固まらないようにする。
 */

/** タイル 1 枚の幅(px)。見えている幅(画面 1 枚ぶん)より少し広い程度 */
export const WAVEFORM_TILE_WIDTH = 2048

/** Chromium の canvas の一辺の上限(これを超えると何も描かれない) */
export const CANVAS_MAX_SIDE = 65535

/** 外側の山を、まわりの何列ぶんの大きい方で取るか。広げすぎると音の出始め・終わりが太って時刻がずれて見える */
export const PEAK_REACH = 1

/** 「塗られている」とみなす不透明度(ffmpeg の絵の縁のにじみを拾わない) */
const ALPHA_THRESHOLD = 24

export interface WaveTile {
  /** 絵の中の左端(px) */
  x: number
  /** 幅(px) */
  w: number
}

/** 幅 `total` の絵を、`tile` 幅ずつのタイルに分ける(最後の 1 枚は残りの幅) */
export function waveformTiles(total: number, tile: number = WAVEFORM_TILE_WIDTH): WaveTile[] {
  const width = Math.max(0, Math.round(total))
  const step = Math.max(1, Math.min(Math.round(tile), CANVAS_MAX_SIDE))
  const tiles: WaveTile[] = []
  for (let x = 0; x < width; x += step) tiles.push({ x, w: Math.min(step, width - x) })
  return tiles
}

/**
 * タイルを描くのに読む範囲。外側の山はまわり `reach` 列を見るので、左右に `reach` だけ
 * はみ出して読む(タイルの境目で山が欠けない)。`offset` は読んだ範囲の中でタイルが始まる位置
 */
export function tileReadRange(
  tile: WaveTile,
  total: number,
  reach: number = PEAK_REACH
): { sx: number; sw: number; offset: number } {
  const sx = Math.max(0, tile.x - reach)
  const end = Math.min(Math.round(total), tile.x + tile.w + reach)
  return { sx, sw: Math.max(0, end - sx), offset: tile.x - sx }
}

/**
 * 列ごとの音の大きさ(中心からの高さ, px)を、ffmpeg の絵(RGBA)から読む。
 * 絵は `showwavespic` の既定(列ごとの平均)で、中心から上下へ対称に塗られている。
 */
export function columnLevels(rgba: ArrayLike<number>, w: number, h: number): Float32Array {
  const levels = new Float32Array(w)
  const center = (h - 1) / 2
  for (let x = 0; x < w; x++) {
    let top = -1
    let bottom = -1
    for (let y = 0; y < h; y++) {
      if (rgba[(y * w + x) * 4 + 3] > ALPHA_THRESHOLD) {
        if (top < 0) top = y
        bottom = y
      }
    }
    levels[x] = top < 0 ? 0 : Math.max(center - top, bottom - center) + 0.5
  }
  return levels
}

/**
 * 1 画面 px あたり何列の絵を頼むか。細かく(1px に 2 本)描くために 2 倍で頼むが、
 * 絵の幅が canvas の上限を超えるほど長いクリップでは 1 倍に戻す(ffmpeg の絵が重くなりすぎない)
 */
export const WAVEFORM_DENSITY = 2
export const WAVEFORM_DENSE_MAX_WIDTH = CANVAS_MAX_SIDE

export function waveformDensity(screenWidth: number): number {
  return screenWidth * WAVEFORM_DENSITY <= WAVEFORM_DENSE_MAX_WIDTH ? WAVEFORM_DENSITY : 1
}

/** 高さの分解能のために、縦も何倍で頼むか(描く時は枠の高さに縮める) */
export const WAVEFORM_HEIGHT_SCALE = 2

/**
 * 振幅を平方根で持ち上げる(dB のように丸い塊に潰さず、小さい音も見え、尖りは残る)。
 * `levels` は中心からの高さ(px)、`half` は半分の高さ(px)。新しい配列を返す
 */
export function liftLevels(
  levels: Float32Array,
  half: number,
  exponent: number = 0.5
): Float32Array {
  const out = new Float32Array(levels.length)
  if (half <= 0) return out
  for (let x = 0; x < levels.length; x++) {
    const v = Math.min(1, Math.max(0, levels[x] / half))
    out[x] = v > 0 ? Math.pow(v, exponent) * half : 0
  }
  return out
}

/** 外側の山: 各列について、まわり `reach` 列のうち大きい方 */
export function peakEnvelope(levels: Float32Array, reach: number = PEAK_REACH): Float32Array {
  const out = new Float32Array(levels.length)
  for (let x = 0; x < levels.length; x++) {
    let peak = levels[x]
    for (let k = 1; k <= reach; k++) {
      if (x - k >= 0 && levels[x - k] > peak) peak = levels[x - k]
      if (x + k < levels.length && levels[x + k] > peak) peak = levels[x + k]
    }
    out[x] = peak
  }
  return out
}

/**
 * ffmpeg が作れる絵の大きさの上限(`(w+128)*(h+128) < 2^28`。超えると絵が作られず、波形が出ない)。
 * 2.5〜3 時間のクリップを最大拡大すると、縦 2 倍で越えていた
 */
export const FFMPEG_MAX_PIXELS = 2 ** 28

export function fitsFfmpegImage(w: number, h: number): boolean {
  return (Math.round(w) + 128) * (Math.round(h) + 128) < FFMPEG_MAX_PIXELS
}

/**
 * 絵の波形(値で描けないときの戻り先)を頼む大きさ。細かく(横 2 倍・縦 2 倍)頼み、上限を越えるなら
 * 横 1 倍 → 縦 1 倍 → 幅を上限まで縮める、の順に落とす(縮めた絵は枠いっぱいに引き伸ばして描く)
 */
export function waveformImageRequestSize(
  screenWidth: number,
  screenHeight: number
): { width: number; height: number } {
  const w = Math.max(1, screenWidth)
  const h = Math.max(1, screenHeight)
  const tries: [number, number][] = [
    [waveformDensity(w), WAVEFORM_HEIGHT_SCALE],
    [1, WAVEFORM_HEIGHT_SCALE],
    [1, 1]
  ]
  for (const [dx, dy] of tries) {
    const width = Math.round(w * dx)
    const height = Math.round(h * dy)
    if (fitsFfmpegImage(width, height)) return { width, height }
  }
  const height = Math.round(h)
  const width = Math.max(1, Math.floor(FFMPEG_MAX_PIXELS / (height + 128)) - 129)
  return { width, height }
}

/**
 * 大きさ(バイト)の合計で上限を持つ、古いものから捨てる覚え場所(ほどいた波形の絵など)。
 * 数だけで上限を持つと、長いクリップの大きな絵が 64 枚溜まって画面のメモリが膨らんでいた
 */
export class ByteLimitedCache<V> {
  private readonly map = new Map<string, { value: V; size: number }>()
  private total = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries: number = Number.POSITIVE_INFINITY
  ) {}

  get bytes(): number {
    return this.total
  }

  get size(): number {
    return this.map.size
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key: string, value: V, size: number): void {
    this.delete(key)
    // 1 つで上限を越えるものは覚えない(覚えると、ほかを全部捨てても収まらない)
    if (size > this.maxBytes) return
    this.map.set(key, { value, size })
    this.total += size
    while (this.total > this.maxBytes || this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
  }

  delete(key: string): void {
    const hit = this.map.get(key)
    if (!hit) return
    this.map.delete(key)
    this.total -= hit.size
  }
}

/**
 * 見えなくなったタイルの canvas の中身を捨てる(幅・高さを 0 にすると描いた絵の記憶が放される)。
 * 消すだけ(clearRect)では記憶が残り、3 時間の素材を端まで送ると画面のメモリが 1GB を越えていた
 */
export function releaseCanvas(canvas: { width: number; height: number }): void {
  canvas.width = 0
  canvas.height = 0
}

/** 振幅(-1〜1)を平方根で持ち上げる。符号は残す(上下の非対称をそのまま描く) */
export function liftAmplitude(v: number, exponent: number = 0.5): number {
  if (!(v === v) || v === 0) return 0
  const a = Math.min(1, Math.abs(v))
  return Math.sign(v) * Math.pow(a, exponent)
}

/**
 * 細かい波形の 1 列の縦の範囲(px)。外側の山は最大〜最小(上下非対称のまま)、内側の RMS は
 * 中心から上下に同じだけ取り、山の範囲からははみ出させない(片側だけの音で、無い側に RMS を描かない)。
 * `cy` は中心、`amp` は振幅 1 のときの高さ。上が小さい y
 */
export function peakColumnSpan(
  max: number,
  min: number,
  rms: number,
  cy: number,
  amp: number
): { top: number; bottom: number; rmsTop: number; rmsBottom: number } {
  const hi = Math.max(liftAmplitude(max), liftAmplitude(min))
  const lo = Math.min(liftAmplitude(max), liftAmplitude(min))
  const top = cy - hi * amp
  const bottom = cy - lo * amp
  const r = liftAmplitude(Math.abs(rms)) * amp
  const rmsTop = Math.max(top, cy - r)
  const rmsBottom = Math.max(rmsTop, Math.min(bottom, cy + r))
  return { top, bottom, rmsTop, rmsBottom }
}

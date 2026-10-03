/**
 * カメラ間の色合わせ(計画書 §5.11)。
 *
 * 機種や設定の違うカメラは、同じ場所・同じ時刻でも色味と明るさが揃わない。基準のカメラ(同期の基準)に
 * 合わせるため、R・G・B それぞれに「倍率と足し込み」(出力 = 入力 × gain + offset)を掛ける。
 *
 * 推定: 同じ時刻のフレームを何枚か取り、チャンネルごとの分布(暗部〜明部の5点の百分位)が
 * 基準カメラの分布に重なるよう、最小二乗で gain と offset を求める。カメラごとに映す範囲は違うので、
 * 1枚どうしではなく数枚を合わせた分布で比べる。行き過ぎた補正にならないよう上限を設ける。
 *
 * 計算は 0〜1 の値(8bit なら ÷255)。書き出し(ffmpeg の lutrgb)とプレビュー(SVG の
 * feComponentTransfer、sRGB で計算)は同じ式になる。
 */

export interface ColorMatch {
  gain: [number, number, number]
  offset: [number, number, number]
}

/** 比べる百分位(暗部・中間・明部) */
export const MATCH_PERCENTILES = [0.05, 0.25, 0.5, 0.75, 0.95] as const
/** 補正の上限。これを超える差は合わせきらない(別の場所を映している・露出の失敗などは人が見る) */
export const GAIN_LIMIT: [number, number] = [0.7, 1.4]
export const OFFSET_LIMIT = 0.12
/**
 * 比べられる画かどうか。暗部〜明部の幅(5〜95 百分位)が狭い画(ほぼ単色・真っ暗)は、
 * 分布の形から色の違いを読めないので合わせない。
 */
const MIN_SPREAD = 0.15
/**
 * 合わせたあとも分布の形が大きく違う(5点のどこかが 0.1 以上ずれる)なら、カメラの違いではなく
 * 映っている物の違いなので合わせない(空だけを映すカメラなど)。
 */
const MAX_RESIDUAL = 0.1
/** これより小さい補正は掛けない(差が無いのと同じ) */
const NEGLIGIBLE_GAIN = 0.015
const NEGLIGIBLE_OFFSET = 0.008

/** RGB(8bit を並べたもの)のチャンネルごとの度数 */
export class RgbHistogram {
  readonly bins: [Uint32Array, Uint32Array, Uint32Array] = [
    new Uint32Array(256),
    new Uint32Array(256),
    new Uint32Array(256)
  ]
  count = 0

  /** rgb24 の画素の並び(R,G,B,R,G,B,…) */
  add(rgb: Uint8Array): void {
    for (let i = 0; i + 2 < rgb.length; i += 3) {
      this.bins[0][rgb[i]]++
      this.bins[1][rgb[i + 1]]++
      this.bins[2][rgb[i + 2]]++
    }
    this.count += Math.floor(rgb.length / 3)
  }

  /** チャンネル c の百分位 p(0〜1)を 0〜1 の値で */
  percentile(c: 0 | 1 | 2, p: number): number {
    if (this.count === 0) return NaN
    const target = p * (this.count - 1)
    let acc = 0
    const bins = this.bins[c]
    for (let v = 0; v < 256; v++) {
      acc += bins[v]
      if (acc > target) return v / 255
    }
    return 1
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

/** y ≈ g·x + o の最小二乗(点が1か所に固まっていれば足し込みだけ) */
function fitLine(xs: readonly number[], ys: readonly number[]): { g: number; o: number } {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2
    sxy += (xs[i] - mx) * (ys[i] - my)
  }
  if (sxx < 1e-6) return { g: 1, o: my - mx }
  const g = sxy / sxx
  return { g, o: my - g * mx }
}

/**
 * `source` の分布を `reference` に合わせる補正。差が無ければ null。
 * 画素が少なすぎる(読めたフレームが無い)ときも null。
 */
export function fitColorMatch(source: RgbHistogram, reference: RgbHistogram): ColorMatch | null {
  return judgeColorMatch(source, reference).match
}

/** 合わせなかった理由(画面のログ用) */
export type ColorMatchVerdict = 'matched' | 'same' | 'flat' | 'shape' | 'few'

export const COLOR_VERDICT_TEXT: Record<Exclude<ColorMatchVerdict, 'matched'>, string> = {
  same: '基準カメラとの差がほとんど無いため、そのままにしました',
  flat: '画の明暗の幅が狭く(ほぼ単色・真っ暗)色の違いを読めないため、合わせていません',
  shape: '基準カメラと映っている物が違いすぎて比べられないため、合わせていません',
  few: '基準カメラと同じ時刻の画が読めず、合わせていません'
}

export function judgeColorMatch(
  source: RgbHistogram,
  reference: RgbHistogram
): { match: ColorMatch | null; verdict: ColorMatchVerdict } {
  if (source.count < 1000 || reference.count < 1000) return { match: null, verdict: 'few' }
  const gain: number[] = []
  const offset: number[] = []
  for (const c of [0, 1, 2] as const) {
    const xs = MATCH_PERCENTILES.map((p) => source.percentile(c, p))
    const ys = MATCH_PERCENTILES.map((p) => reference.percentile(c, p))
    if (xs[4] - xs[0] < MIN_SPREAD || ys[4] - ys[0] < MIN_SPREAD)
      return { match: null, verdict: 'flat' }
    const fit = fitLine(xs, ys)
    // 形の違いは、上限で抑える前の当てはまりで見る(上限に当たるだけの大きな差は、上限まで合わせる)
    if (xs.some((x, i) => Math.abs(fit.g * x + fit.o - ys[i]) > MAX_RESIDUAL))
      return { match: null, verdict: 'shape' }
    const g = clamp(fit.g, GAIN_LIMIT[0], GAIN_LIMIT[1])
    // 倍率を抑えたら、中間(50%)が合うよう足し込みを取り直す
    const o = clamp(g === fit.g ? fit.o : ys[2] - g * xs[2], -OFFSET_LIMIT, OFFSET_LIMIT)
    gain.push(round4(g))
    offset.push(round4(o))
  }
  const negligible = gain.every(
    (g, i) => Math.abs(g - 1) < NEGLIGIBLE_GAIN && Math.abs(offset[i]) < NEGLIGIBLE_OFFSET
  )
  if (negligible) return { match: null, verdict: 'same' }
  return {
    match: { gain: gain as [number, number, number], offset: offset as [number, number, number] },
    verdict: 'matched'
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

/** 書き出しの ffmpeg フィルタ(8bit の値 val に掛ける) */
export function colorMatchFilter(m: ColorMatch): string {
  const ch = (i: number): string => `clip(val*${m.gain[i]}+${round4(m.offset[i] * 255)}\\,0\\,255)`
  return `lutrgb=r='${ch(0)}':g='${ch(1)}':b='${ch(2)}'`
}

/** 1画素(0〜1)に掛けた結果。テストとプレビューの確認用 */
export function applyColorMatch(m: ColorMatch, rgb: [number, number, number]): number[] {
  return rgb.map((v, i) => clamp(v * m.gain[i] + m.offset[i], 0, 1))
}

/** 補正の強さを人が読める形に(画面の表示用) */
export function describeColorMatch(m: ColorMatch): string {
  const mid = [0, 1, 2].map((i) => 0.5 * m.gain[i] + m.offset[i] - 0.5)
  const bright = (mid[0] + mid[1] + mid[2]) / 3
  const warm = mid[0] - mid[2]
  const parts: string[] = []
  if (Math.abs(bright) >= 0.01)
    parts.push(`明るさ ${bright > 0 ? '+' : '−'}${Math.round(Math.abs(bright) * 100)}%`)
  if (Math.abs(warm) >= 0.01) parts.push(warm > 0 ? '暖かく' : '冷たく')
  return parts.length > 0 ? parts.join('・') : '微調整'
}

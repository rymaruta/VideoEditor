import { crossCorrelation } from './fft'

/**
 * 音で素材どうしの時刻を合わせる(計画書 §5.2)。
 *
 * 1. 粗く: 音の大きさの「立ち上がり」(包絡線、100Hz)を相互相関して、ずれを 10ms 単位で見つける。
 *    録音機ごとの音量・マイクの位置の違いは、対数を取って差分にすることで打ち消す。
 * 2. 細かく: 粗く合わせた位置の周りだけを 16kHz の波形で GCC-PHAT にかけ、1ms 未満まで詰める。
 *
 * どちらも「b の頭が a の頭から何秒後にあるか」(= offset)を返す。負なら b のほうが先に始まっている。
 */

/** 包絡線の細かさ(1秒あたりの点数) */
export const ENVELOPE_RATE = 100

/**
 * 波形を受け取りながら、10ms ごとの RMS(包絡線)を作る。
 * 4時間の音声を丸ごと持たずに済むよう、少しずつ流し込めるようにしてある。
 */
export class EnvelopeBuilder {
  private readonly hop: number
  private acc = 0
  private count = 0
  private readonly out: number[] = []

  constructor(sampleRate: number) {
    this.hop = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE))
  }

  push(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]
      this.acc += v * v
      if (++this.count === this.hop) {
        this.out.push(Math.sqrt(this.acc / this.hop))
        this.acc = 0
        this.count = 0
      }
    }
  }

  finish(): Float32Array {
    return Float32Array.from(this.out)
  }
}

/**
 * 包絡線を、相関に使う特徴にする: 対数の大きさの増え方(立ち上がり)を、平均0・ばらつき1にそろえる。
 * 音量の違い(カメラのマイクとピンマイク)は対数の差分で消える。無音の区間はほぼ0になる。
 */
export function onsetFeature(envelope: ArrayLike<number>): Float32Array {
  const n = envelope.length
  const out = new Float32Array(n)
  let prev = Math.log(envelope[0] + 1e-4)
  for (let i = 1; i < n; i++) {
    const cur = Math.log(envelope[i] + 1e-4)
    out[i] = Math.max(0, cur - prev)
    prev = cur
  }
  let mean = 0
  for (let i = 0; i < n; i++) mean += out[i]
  mean /= Math.max(1, n)
  let varSum = 0
  for (let i = 0; i < n; i++) varSum += (out[i] - mean) ** 2
  const sd = Math.sqrt(varSum / Math.max(1, n)) || 1
  for (let i = 0; i < n; i++) out[i] = (out[i] - mean) / sd
  return out
}

export interface FeatureMatch {
  /** b の頭が a の頭から何秒後か */
  offset: number
  /** 一致の確からしさ(山の高さが、ほかの位置のばらつきの何倍か) */
  confidence: number
  /** 2番目に良い位置と比べて、どれだけ抜けているか(1 に近いほど紛らわしい) */
  distinctness: number
  /** 重なっている長さ(秒) */
  overlap: number
}

export interface MatchOptions {
  /** これより短い重なりは数えない(秒)。短い重なりは偶然の一致が起きやすい */
  minOverlapSec?: number
  /** 探す範囲を offset のこの区間に絞る(録画時刻が分かっているとき)。未指定なら全範囲 */
  searchRange?: [number, number]
}

function median(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort()
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * 一致を信じてよい基準。
 * 実測(話し声のような音・音量と雑音を変えた録り直し): 関係のない2本は 確からしさ 14〜17・抜け具合 1.03〜1.11、
 * 正しい組は雑音を強くしても 確からしさ 71 以上・抜け具合 4.4 以上。間を取って、十分に余裕のある値にする。
 */
export const MIN_CONFIDENCE = 30
export const MIN_DISTINCTNESS = 1.8

export function isReliableMatch(m: Pick<FeatureMatch, 'confidence' | 'distinctness'>): boolean {
  return m.confidence >= MIN_CONFIDENCE && m.distinctness >= MIN_DISTINCTNESS
}

/** 2つの特徴(onsetFeature)の、いちばん合う位置を探す。重なれる位置が無ければ null */
export function matchFeatures(
  a: Float32Array,
  b: Float32Array,
  options: MatchOptions = {}
): FeatureMatch | null {
  const minOverlap = Math.round((options.minOverlapSec ?? 15) * ENVELOPE_RATE)
  if (a.length < minOverlap || b.length < minOverlap) return null
  const c = crossCorrelation(a, b)
  const na = a.length
  const nb = b.length
  const lo = options.searchRange ? Math.floor(options.searchRange[0] * ENVELOPE_RATE) : -(nb - 1)
  const hi = options.searchRange ? Math.ceil(options.searchRange[1] * ENVELOPE_RATE) : na - 1

  // 重なりの長さで割り引いた得点(重なりが長いほど偶然でも和が大きくなるので √重なり で割る)
  const lags: number[] = []
  const scores: number[] = []
  for (let k = Math.max(lo, -(nb - 1)); k <= Math.min(hi, na - 1); k++) {
    const ov = Math.min(nb, na - k) - Math.max(0, -k)
    if (ov < minOverlap) continue
    lags.push(k)
    scores.push(c[k + nb - 1] / Math.sqrt(ov))
  }
  if (scores.length < 3) return null

  let best = 0
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i
  // ばらつきは間引いて測る(百万点の並べ替えを避ける)
  const step = Math.max(1, Math.floor(scores.length / 20000))
  const sample = new Float64Array(Math.ceil(scores.length / step))
  for (let i = 0, j = 0; i < scores.length; i += step, j++) sample[j] = scores[i]
  const med = median(sample)
  const mad = median(sample.map((v) => Math.abs(v - med))) * 1.4826 || 1e-9
  // 2番目の山: 1秒より離れた位置での最大
  const guard = ENVELOPE_RATE
  let second = -Infinity
  for (let i = 0; i < scores.length; i++) {
    if (Math.abs(lags[i] - lags[best]) > guard && scores[i] > second) second = scores[i]
  }
  const peak = scores[best]
  const k = lags[best]
  return {
    offset: k / ENVELOPE_RATE,
    confidence: (peak - med) / mad,
    distinctness: second === -Infinity ? Infinity : (peak - med) / Math.max(1e-9, second - med),
    overlap: (Math.min(nb, na - k) - Math.max(0, -k)) / ENVELOPE_RATE
  }
}

export interface DriftMatch extends FeatureMatch {
  /** offset を測った位置(a の時刻) */
  center: number
  /** b の時計の速さ(a の 1 秒が b の何秒か)。1 + ずれ */
  rate: number
}

/**
 * 時計がずれている長い2本を、区切った窓ごとに照らし合わせて、ずれ(offset)と時計の速さを同時に求める。
 *
 * 丸ごと相関を取ると、時計のずれの分だけ山が横に広がって低くなる
 * (200ppm × 12分 = 0.15 秒 = 15 点。確からしさが 140 → 20 に落ち、「合わない」と判断されていた)。
 * 2分の窓なら広がりは 2〜3 点に収まる。窓ごとの offset を直線に当て、外れた窓を除いてから、
 * 3つ以上の窓が 30ms 以内で一直線に並んだときだけ信じる(偶然の一致は直線に並ばない)。
 */
export function matchWithDrift(
  a: Float32Array,
  b: Float32Array,
  options: { windowSec?: number; maxWindows?: number } = {}
): DriftMatch | null {
  const winSec = options.windowSec ?? 120
  const w = Math.round(winSec * ENVELOPE_RATE)
  const count = Math.min(options.maxWindows ?? 8, Math.floor(b.length / w))
  if (count < 3 || a.length < w) return null
  const step = (b.length - w) / (count - 1)
  let points: { c: number; o: number; m: FeatureMatch }[] = []
  for (let k = 0; k < count; k++) {
    const s = Math.round(k * step)
    const m = matchFeatures(a, b.subarray(s, s + w), { minOverlapSec: winSec * 0.8 })
    if (!m || !isReliableMatch(m)) continue
    // 窓の頭(b の時刻 s)が a の m.offset 秒にある → b の頭は a の (m.offset - s) 秒(その位置での値)
    points.push({ c: m.offset + winSec / 2, o: m.offset - s / ENVELOPE_RATE, m })
  }
  const fit = (ps: typeof points): { o0: number; k: number } => {
    const n = ps.length
    const mc = ps.reduce((t, p) => t + p.c, 0) / n
    const mo = ps.reduce((t, p) => t + p.o, 0) / n
    let num = 0
    let den = 0
    for (const p of ps) {
      num += (p.c - mc) * (p.o - mo)
      den += (p.c - mc) ** 2
    }
    const k = den > 0 ? num / den : 0
    return { o0: mo - k * mc, k }
  }
  // 外れた窓(偶然の一致)を1つずつ除く
  while (points.length >= 3) {
    const { o0, k } = fit(points)
    const res = points.map((p) => Math.abs(p.o - (o0 + k * p.c)))
    const worst = res.indexOf(Math.max(...res))
    if (res[worst] <= 0.03) {
      // 時計のずれは現実の録音機の範囲(±0.2%)に限る
      if (Math.abs(k) > 2e-3) return null
      const center = points.reduce((t, p) => t + p.c, 0) / points.length
      const conf = points.map((p) => p.m.confidence).sort((x, y) => x - y)
      const dist = points.map((p) => p.m.distinctness).sort((x, y) => x - y)
      const offset = o0 + k * center
      return {
        offset,
        center,
        // b の頭の位置が a の後ろほど手前に見える(k < 0)のは、b の時計が速いとき
        rate: 1 - k,
        confidence: conf[Math.floor(conf.length / 2)],
        distinctness: dist[Math.floor(dist.length / 2)],
        overlap:
          (Math.min(b.length, a.length - offset * ENVELOPE_RATE) -
            Math.max(0, -offset * ENVELOPE_RATE)) /
          ENVELOPE_RATE
      }
    }
    points = points.filter((_, i) => i !== worst)
  }
  return null
}

/**
 * 粗く合わせた後の細かい合わせ込み(GCC-PHAT)。
 * `aWin` は a の時刻 s からの波形、`bWin` は b の時刻 s - coarseOffset からの波形(どちらも同じ長さ・同じ周波数)。
 * 戻り値は詰めた後の offset(秒)と、山の鋭さ(大きいほど確か)。
 */
export function refineOffset(
  aWin: ArrayLike<number>,
  bWin: ArrayLike<number>,
  sampleRate: number,
  coarseOffset: number,
  maxShiftSec = 0.05
): { offset: number; sharpness: number } {
  const c = crossCorrelation(aWin, bWin, true)
  const zero = bWin.length - 1
  const maxLag = Math.round(maxShiftSec * sampleRate)
  let best = zero
  for (let k = -maxLag; k <= maxLag; k++) {
    const i = zero + k
    if (i >= 0 && i < c.length && c[i] > c[best]) best = i
  }
  // 山の頂点を放物線で補間して、1サンプル未満まで詰める
  let frac = 0
  if (best > 0 && best < c.length - 1) {
    const y0 = c[best - 1]
    const y1 = c[best]
    const y2 = c[best + 1]
    const denom = y0 - 2 * y1 + y2
    if (Math.abs(denom) > 1e-12) frac = (0.5 * (y0 - y2)) / denom
  }
  let sum = 0
  let cnt = 0
  for (let k = -maxLag; k <= maxLag; k++) {
    const i = zero + k
    if (i >= 0 && i < c.length) {
      sum += Math.abs(c[i])
      cnt++
    }
  }
  const mean = sum / Math.max(1, cnt)
  return {
    offset: coarseOffset + (best - zero + frac) / sampleRate,
    sharpness: mean > 0 ? c[best] / mean : 0
  }
}

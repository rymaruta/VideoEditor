/**
 * ダッキング(本編がしゃべっている間だけ BGM を下げる)の規則。
 *
 * 書き出しは ffmpeg の `sidechaincompress`、プレビューは Web Audio と、**道具が違う**。
 * だからこそパラメータと計算式はここ1箇所に置く。書き写すと、切り替えても画面では
 * 何も変わらないのに書き出しだけ音が変わる、という食い違いが生まれる
 * (実際そうなっていた。実測: 画面側の倍率は ON/OFF どちらも 0.60/1.20/0.60 と完全に
 * 同一なのに、書き出すと BGM の帯域が mean -24.1dB → -27.5dB と **-3.4dB** 下がっていた)。
 */

/** `sidechaincompress` に渡す値。プレビューの計算もこの数字から導く。 */
export const DUCKING = {
  /** これを超えた本編の音量から圧縮が始まる(0〜1 の振幅) */
  threshold: 0.05,
  /** 超えたぶんを何分の1にするか */
  ratio: 8,
  /** 下げ始めの時定数(ms) */
  attackMs: 20,
  /** 戻りの時定数(ms) */
  releaseMs: 250
} as const

/** 書き出しのフィルタ式。数字を直接書かず、必ずここから組み立てる。 */
export function duckingFilterArgs(): string {
  return `sidechaincompress=threshold=${DUCKING.threshold}:ratio=${DUCKING.ratio}:attack=${DUCKING.attackMs}:release=${DUCKING.releaseMs}`
}

/**
 * 本編の音量(0〜1 の振幅)から、BGM に掛ける倍率を求める。
 *
 * コンプレッサの静特性そのまま: しきい値を超えたぶんだけを dB で `ratio` 分の1に潰す。
 *   超過dB = 20*log10(level / threshold)
 *   下げるdB = 超過dB * (1 - 1/ratio)
 * しきい値以下は 1(素通し)。**時間方向のなまし(attack/release)は別**
 * (`smoothDuckGain`)——静特性だけ掛けると音がガタつく。
 */
export function duckTargetGain(level: number): number {
  if (!Number.isFinite(level) || level <= DUCKING.threshold) return 1
  const overshootDb = 20 * Math.log10(level / DUCKING.threshold)
  const reductionDb = overshootDb * (1 - 1 / DUCKING.ratio)
  return Math.pow(10, -reductionDb / 20)
}

/**
 * 倍率を attack/release でなまして、次の値を返す。
 *
 * 下げる向き(target < current)は attack、戻す向きは release の時定数を使う。
 * 指数で寄せるので、`dtMs` がどれだけ飛んでも行き過ぎない。
 */
export function smoothDuckGain(current: number, target: number, dtMs: number): number {
  if (!Number.isFinite(current)) return Number.isFinite(target) ? target : 1
  if (!Number.isFinite(target)) return current
  if (!Number.isFinite(dtMs) || dtMs <= 0) return current
  const tau = target < current ? DUCKING.attackMs : DUCKING.releaseMs
  if (tau <= 0) return target
  const k = Math.exp(-dtMs / tau)
  return target + (current - target) * k
}

/**
 * 波形の実効値(RMS)。`AnalyserNode.getFloatTimeDomainData` の中身をそのまま渡す。
 * 空なら 0(無音扱い)。数値でない値は捨てる——1つ混ざるだけで合計が NaN になり、
 * **BGM が下がりっぱなしにも上がりっぱなしにもなり得る**。
 */
export function rmsOf(samples: ArrayLike<number>): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]
    if (!Number.isFinite(v)) continue
    sum += v * v
    n++
  }
  if (n === 0) return 0
  return Math.sqrt(sum / n)
}

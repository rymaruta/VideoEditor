import type { HighlightSensitivity } from './types'

export const DEFAULT_HIGHLIGHT_SENSITIVITY: HighlightSensitivity = 'normal'

/**
 * 感度ごとのしきい値の決め方。
 *
 * しきい値は「平均音量からどれだけ上を山とみなすか」で、`平均 + max(下限dB, 標準偏差 × 係数)`。
 * 2つの項がそれぞれ別の外れ方を受け持つ:
 * - `標準偏差 × 係数`: 音量の起伏が大きい素材で効く。係数が1のままだと**起伏が大きいほど
 *   しきい値も上がってしまい、山があるのに1つも超えない**。
 * - `下限dB`: 音量がほぼ一定の素材で効く。標準偏差がほぼ0だと下限がそのまま基準になるので、
 *   下限が高すぎると**平坦な素材で常に0件**になる。
 *
 * `normal` は従来の固定値 `平均 + max(3, 標準偏差)` と同じ(既定の挙動を変えないため)。
 */
const SENSITIVITY_PARAMS: Record<HighlightSensitivity, { stddevFactor: number; floorDb: number }> =
  {
    low: { stddevFactor: 1.5, floorDb: 5 },
    normal: { stddevFactor: 1, floorDb: 3 },
    high: { stddevFactor: 0.5, floorDb: 1 }
  }

export const HIGHLIGHT_SENSITIVITY_OPTIONS: {
  value: HighlightSensitivity
  label: string
}[] = [
  { value: 'low', label: '絞る(強い山だけ)' },
  { value: 'normal', label: 'ふつう' },
  { value: 'high', label: '多く拾う' }
]

/**
 * 音量の山とみなす下限(dB)を返す。
 *
 * `stddev` が数値でない・負のときは 0 として扱う(分散から求めるので本来は非負だが、
 * 1件でも壊れた値が混ざるとしきい値ごと NaN になり、比較が全部 false = 無音扱いで
 * 静かに0件になるため)。
 */
export function highlightThreshold(
  mean: number,
  stddev: number,
  sensitivity: HighlightSensitivity = DEFAULT_HIGHLIGHT_SENSITIVITY
): number {
  const { stddevFactor, floorDb } = SENSITIVITY_PARAMS[sensitivity] ?? SENSITIVITY_PARAMS.normal
  const safeStddev = Number.isFinite(stddev) && stddev > 0 ? stddev : 0
  const safeMean = Number.isFinite(mean) ? mean : 0
  return safeMean + Math.max(floorDb, safeStddev * stddevFactor)
}

/** 音量統計から外す下限。これ以下は事実上の無音 */
export const STATS_FLOOR_DB = -90

/**
 * 統計に使う音量の幅(最大からこのdB以内のフレームだけを使う)。
 *
 * 末尾の切れ端など**ほぼ無音のフレームが1つ混ざるだけで平均が下がり標準偏差が跳ね上がる**。
 * しきい値は `平均 + 標準偏差` なので、その1件のせいで**実際の最大音量より高い**しきい値に
 * なり、山があるのに0件になる。「無音に近い部分は"ふだんの音量"ではない」として外す。
 */
export const STATS_DYNAMIC_RANGE_DB = 40

/**
 * 上の窓を適用してよい下限(残るフレームの割合)。
 *
 * **外れ値として外してよいのは少数派だけ。過半数が窓の外なら、それは外れ値ではなく
 * 素材そのもの。** 静かな部屋で録った素材は、地の音が山より 40dB 以上低いのが普通で
 * (良い録り方をしているほどそうなる)、そこで窓を当てると**残るのは山だけ**になる。
 * すると平均は山そのもの・ばらつきは 0 へ潰れ、しきい値 `平均 + 下限dB` が
 * **必ず最大値より上**に来る——構造的に1件も超えられない。
 * 上の窓が防ごうとしたのと**同じ壊れ方が、窓のせいで逆向きに起きる**。
 *
 * (実測: 20秒の素材の 6.0〜12.0秒だけ大きい音。地の音を下げていくと、
 *  山との差 37.0dB までは 20/20フレームを採用して平均 -49.97・ばらつき 16.95・
 *  しきい値 -33.02 で**1件**検出できるのに、42.0dB になった途端 **6/20** しか
 *  採用されず、平均 **-24.07**(＝山そのもの)・ばらつき **0.00**・しきい値 **-21.07** と
 *  山の -24.1 を追い越して **0件**。感度を low/normal/high のどれにしても 0件で、
 *  画面の「感度を『多く拾う』にすると見つかることがあります」という案内どおりにしても
 *  直らなかった。長尺スキャンも同じ素材で 1件 → 0件)
 */
export const STATS_MIN_KEPT_RATIO = 0.5

/**
 * ハイライト判定に使う平均と標準偏差を、無音に近いフレームを外して求める。
 * 使える値が1つも無ければ、従来どおり平均 -50dB・ばらつき0として扱う。
 */
export function loudnessStats(rmsDbValues: number[]): {
  mean: number
  stddev: number
  /** 統計に使ったフレーム数(外れ値を落とした後) */
  used: number
} {
  const finite = rmsDbValues.filter((v) => Number.isFinite(v) && v > STATS_FLOOR_DB)
  if (finite.length === 0) return { mean: -50, stddev: 0, used: 0 }
  const peak = Math.max(...finite)
  const kept = finite.filter((v) => v >= peak - STATS_DYNAMIC_RANGE_DB)
  // 窓の外が過半数なら窓を使わない(理由は STATS_MIN_KEPT_RATIO)。
  const sample = kept.length > finite.length * STATS_MIN_KEPT_RATIO ? kept : finite
  const mean = sample.reduce((sum, v) => sum + v, 0) / sample.length
  const variance = sample.reduce((sum, v) => sum + (v - mean) ** 2, 0) / sample.length
  return { mean, stddev: Math.sqrt(variance), used: sample.length }
}

/**
 * 書き出しの音量の基準(ラウドネス)。
 *
 * - `web`: 配信向け。YouTube などの再生側の基準に合わせた −14 LUFS(既定)
 * - `broadcast`: 放送向け。ARIB TR-B32 の −24 LKFS(LKFS と LUFS は同じ尺度)
 *
 * 標準の書き出しと長尺向けの書き出しが**同じ loudnorm の指定**を使うよう、式はここ1つに置く。
 */
export type LoudnessTarget = 'web' | 'broadcast'

export const LOUDNESS_TARGETS: Record<
  LoudnessTarget,
  { integrated: number; truePeak: number; label: string }
> = {
  web: { integrated: -14, truePeak: -1.5, label: '配信 −14 LUFS' },
  // 放送はトゥルーピークの上限(−1 dBTP)に余裕を持たせる
  broadcast: { integrated: -24, truePeak: -2, label: '放送 −24 LKFS' }
}

export function normalizeLoudnessTarget(value: unknown): LoudnessTarget {
  return value === 'broadcast' ? 'broadcast' : 'web'
}

/** 2パスの1回目(測るだけ)の loudnorm */
export function loudnormMeasureFilter(target: LoudnessTarget = 'web'): string {
  const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
  return `loudnorm=I=${t.integrated}:TP=${t.truePeak}:LRA=11:print_format=json`
}

export interface LoudnessMeasurementValues {
  inputI: number
  inputTP: number
  inputLRA: number
  inputThresh: number
  targetOffset: number
}

/**
 * 2パスの2回目(本番)の loudnorm。測れていれば measured_* を渡して linear(一定のゲイン)で掛ける。
 *
 * LRA の指定は linear では「これを超えたら dynamic へ落とす」閾値でしかなく、増幅量には効かない。
 * 素材の LRA が 11 を超えていると黙って dynamic に戻ってしまう(実測: LRA 18.5 の素材で
 * 2パス目も -14.57/LRA 14.4 のまま)ので、測った LRA を下回らない値を渡して linear を守る
 * (上限 50 は loudnorm の定義域)。測れなかったときは従来の1パス(dynamic)へ落とす。
 */
export function loudnormApplyFilter(
  target: LoudnessTarget = 'web',
  measured: LoudnessMeasurementValues | null
): string {
  const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
  const base = `loudnorm=I=${t.integrated}:TP=${t.truePeak}`
  if (!measured) return `${base}:LRA=11`
  const lra = Math.min(50, Math.max(11, Math.ceil(measured.inputLRA)))
  return (
    `${base}:LRA=${lra}:measured_I=${measured.inputI}:` +
    `measured_TP=${measured.inputTP}:measured_LRA=${measured.inputLRA}:` +
    `measured_thresh=${measured.inputThresh}:offset=${measured.targetOffset}:linear=true`
  )
}

/** サンプルの山で抑えるときの、トゥルーピークの上限からの余裕(dB) */
const TRUE_PEAK_MARGIN_DB = 0.5
/** 一定のゲイン + リミッタで合わせるときに、これより近ければ合ったとする(LU) */
export const LIMITED_GAIN_TOLERANCE_LU = 0.3

/**
 * 一定のゲインで基準まで上げるとトゥルーピークの上限を越えるか(まばらに鋭い山がある素材)。
 * そういう素材では loudnorm が黙って dynamic に戻り、リミッタで全体が下がって基準に届かない
 * (実測: 配信で -15.2、放送で -26.2 LUFS)。この場合は自分で一定のゲインを掛けて越える山だけを抑え、
 * 抑えた後の大きさを測り直してゲインを直す(`limitedGainFilter`)
 */
export function needsLimitedGain(
  target: LoudnessTarget,
  measured: LoudnessMeasurementValues | null
): boolean {
  if (!measured) return false
  const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
  const gain = t.integrated - measured.inputI
  return (
    Number.isFinite(gain) &&
    Number.isFinite(measured.inputTP) &&
    measured.inputTP + gain > t.truePeak
  )
}

/** 一定のゲイン(dB)を掛け、上限を越える山だけを抑える */
export function limitedGainFilter(target: LoudnessTarget, gainDb: number): string {
  const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
  // サンプルの山で抑えるので、トゥルーピーク(山の間の値)の分だけ少し低めに抑える
  const limit = Math.pow(10, (t.truePeak - TRUE_PEAK_MARGIN_DB) / 20)
  return `volume=${gainDb.toFixed(2)}dB,alimiter=limit=${limit.toFixed(4)}:level=disabled:attack=1:release=50`
}

/**
 * 一定のゲイン + リミッタの掛け方を決める。`measure(フィルタ)` はそのフィルタを掛けた後の大きさを測る。
 * 抑えた山の分だけ大きさが下がるので、測り直してゲインを足す(数回で基準に寄る)。
 * 測れなければ null(呼び出し側は loudnorm に任せる)
 */
export async function planLimitedGain(
  target: LoudnessTarget,
  measured: LoudnessMeasurementValues,
  measure: (filter: string) => Promise<LoudnessMeasurementValues | null>
): Promise<string | null> {
  const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
  let gain = t.integrated - measured.inputI
  for (let i = 0; i < 4; i++) {
    const filter = limitedGainFilter(target, gain)
    const r = await measure(filter)
    if (!r || !Number.isFinite(r.inputI)) return i === 0 ? null : filter
    const miss = t.integrated - r.inputI
    if (Math.abs(miss) <= LIMITED_GAIN_TOLERANCE_LU) return filter
    gain += miss
  }
  return limitedGainFilter(target, gain)
}

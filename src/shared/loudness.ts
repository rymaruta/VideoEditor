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

/**
 * リミッタで抑える高さの、測ったトゥルーピークの上限(`peakCeiling`)からの余裕(dB)の始めの値。
 * 4 倍の細かさで抑えると、測ったトゥルーピークはほぼ抑えた高さになる。上限より高く抑え始めると
 * 1回目の測りが必ず「越えた」になり、書き出しのたびに音を丸ごと測り直していた
 */
const TRUE_PEAK_MARGIN_DB = 0.1
/**
 * 書き出しの前(浮動小数)で測ったトゥルーピークに残す、AAC にしたときの持ち上がり分(dB)。
 * 実測: 書き出しの前で -0.9 dBTP の音が、AAC にすると -0.1 dBTP になった
 */
const AAC_TRUE_PEAK_HEADROOM_DB = 1
/** 一定のゲイン + リミッタで合わせるときに、これより近ければ合ったとする(LU) */
export const LIMITED_GAIN_TOLERANCE_LU = 0.3

/**
 * 一定のゲインで基準まで上げるとトゥルーピークの上限を越えるか(まばらに鋭い山がある素材)。
 * そういう素材では loudnorm が黙って dynamic に戻り、リミッタで全体が下がって基準に届かない
 * (実測: 配信で -15.2、放送で -26.2 LUFS)。この場合は自分で一定のゲインを掛けて越える山だけを抑え、
 * 抑えた後の大きさを測り直してゲインを直す(`planLimitedGain`)
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

/**
 * 一定のゲイン(dB)を掛け、`ceilingDb` を越える山だけを抑える。リミッタは先読みの分だけ音を遅らせるので、
 * 遅れを戻す(`latency=1`。戻さないと映像より約 1ms 遅れた)
 */
export function limitedGainFilter(gainDb: number, ceilingDb: number): string {
  const limit = Math.min(1, Math.max(0.0625, Math.pow(10, ceilingDb / 20)))
  // 4 倍の細かさで抑える(サンプルの間の山 = トゥルーピークも抑えるため)。後で元の細かさに戻す
  return (
    `volume=${gainDb.toFixed(2)}dB,aresample=192000,` +
    `alimiter=limit=${limit.toFixed(4)}:level=disabled:attack=1:release=50:latency=1,aresample=48000`
  )
}

/**
 * 一定のゲイン + リミッタの掛け方を決める。`measure(フィルタ)` はそのフィルタを掛けた後の大きさを測る。
 * 抑えた山の分だけ大きさが下がるので、測り直してゲインを足す。リミッタはサンプルの山しか抑えないので、
 * 測ったトゥルーピークが上限(AAC にしたときの持ち上がり分を残す)を越えていれば、抑える高さを下げて
 * 測り直す。測れなければ null(呼び出し側は loudnorm に任せる)
 */
export async function planLimitedGain(
  target: LoudnessTarget,
  measured: LoudnessMeasurementValues,
  measure: (filter: string) => Promise<LoudnessMeasurementValues | null>
): Promise<string | null> {
  const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
  const peakCeiling = t.truePeak - AAC_TRUE_PEAK_HEADROOM_DB
  let gain = t.integrated - measured.inputI
  let ceiling = peakCeiling - TRUE_PEAK_MARGIN_DB
  for (let i = 0; i < 6; i++) {
    const filter = limitedGainFilter(gain, ceiling)
    const r = await measure(filter)
    if (!r || !Number.isFinite(r.inputI)) return i === 0 ? null : filter
    const miss = t.integrated - r.inputI
    const over = Number.isFinite(r.inputTP) ? r.inputTP - peakCeiling : 0
    if (Math.abs(miss) <= LIMITED_GAIN_TOLERANCE_LU && over <= 0) return filter
    gain += miss
    if (over > 0) ceiling -= over + 0.1
  }
  return limitedGainFilter(gain, ceiling)
}

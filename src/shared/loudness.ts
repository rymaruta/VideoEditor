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

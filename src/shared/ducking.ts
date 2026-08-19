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

/**
 * 「本編の音」に数える音声クリップかどうか。
 *
 * ダッキングが下げる相手を決める基準は**本編がしゃべっているか**なので、
 * 「本編の音」がどこにあるかを画面と書き出しがそれぞれ決め打ちしてはいけない。
 * 音声分離(`audioDetached`)を使うと、本編クリップの音声は**音声トラックへ移る**
 * (移った先のクリップは `linkedClipId` で本編クリップに紐付き、位置も速度も追従する)。
 * 移ったことを見ていないと、画面は `muted` の `<video>`、書き出しは `anullsrc` の枝を
 * 測ることになり、**どちらも無音を測って一度も反応しなくなる**
 * (実測: 書き出しの下がり幅 6.90dB → -0.70dB、画面の倍率 0.1526/0.9924 → 1.0000/1.0000)。
 *
 * リンクが外れたクリップ(利用者が手で動かした・分割した)は、もう本編の音ではなく
 * ただの音声素材なので数えない。
 */
export function isMainVoiceClip(clip: { linkedClipId?: string }): boolean {
  return Boolean(clip.linkedClipId)
}

/** 書き出しのフィルタ式。数字を直接書かず、必ずここから組み立てる。 */
export function duckingFilterArgs(): string {
  return `sidechaincompress=threshold=${DUCKING.threshold}:ratio=${DUCKING.ratio}:attack=${DUCKING.attackMs}:release=${DUCKING.releaseMs}`
}

/**
 * `sidechaincompress` の既定の knee(ソフトニー)。書き出し側は指定していないので
 * この既定が効いている。画面も同じ値でカーブを描かないと、しきい値の近くだけ
 * 画面と書き出しが食い違う。
 */
export const DUCKING_KNEE = 2.82843

/**
 * 書き出し(`sidechaincompress`)の検出器を、そのまま画面用に写した模型。
 *
 * 以前の画面は「1コマぶんの単純な実効値 → 静特性 → 倍率をなます」だったが、
 * ffmpeg の検出器は**1サンプルずつ電力を非対称(attack/release)に追従**するので、
 * アタックがリリースよりずっと速いと**実効値ではなく峰の近く**で落ち着く。
 * 同じしきい値・比を配っても、**書き出しだけ常に約2dB深く下がっていた**のはこのため。
 *
 * ここの式は推測ではなく**実測合わせ**:
 * ffmpeg 単体にピーク振幅0.04〜1.4の正弦をサイドチェインで通して下がり幅を測り
 * (Goertzel で BGM 成分だけ取り出す)、この模型が**全11点で差 0.00dB**、
 * 過渡(ON/OFF の立ち上がり・戻り)も 0.2dB 以内で一致することを確かめてある。
 * - 追従係数は 1サンプルあたり `4000 / (時定数ms × サンプルレート)`
 * - 検出レベルは `√env`(env は電力の追従値。定常の正弦なら実効値の約1.29倍で落ち着く)
 * - 静特性は log 領域で、knee 区間はエルミート補間
 */
export interface DuckDetectorState {
  /** 電力(振幅の二乗)を追従している内部状態 */
  env: number
}

export function createDuckDetector(): DuckDetectorState {
  return { env: 0 }
}

/**
 * 電力の列(サンプルごとの振幅²。複数の測り口は電力を足してから渡す——
 * 無相関な音の合成は電力の足し算)で検出器を進める。
 * 数でない値・負の値は捨てる(1つ混ざるだけで env が NaN になり、
 * BGM が下がりっぱなしにも上がりっぱなしにもなり得る)。
 */
export function advanceDuckDetector(
  state: DuckDetectorState,
  powers: ArrayLike<number>,
  count: number,
  sampleRate: number
): void {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return
  const attackCoeff = Math.min(1, 4000 / (DUCKING.attackMs * sampleRate))
  const releaseCoeff = Math.min(1, 4000 / (DUCKING.releaseMs * sampleRate))
  let env = Number.isFinite(state.env) && state.env >= 0 ? state.env : 0
  const n = Math.min(count, powers.length)
  for (let i = 0; i < n; i++) {
    const p = powers[i]
    if (!Number.isFinite(p) || p < 0) continue
    env += (p - env) * (p > env ? attackCoeff : releaseCoeff)
  }
  state.env = env
}

/** 検出器が見ているレベル(振幅)。電力の追従値の平方根。 */
export function duckDetectorLevel(state: DuckDetectorState): number {
  const env = state.env
  if (!Number.isFinite(env) || env <= 0) return 0
  return Math.sqrt(env)
}

function hermite(x: number, x0: number, x1: number, p0: number, p1: number, m1: number): number {
  const w = x1 - x0
  const t = (x - x0) / w
  const t2 = t * t
  const t3 = t2 * t
  // 始点の傾きは 1(圧縮前は素通し)
  return (
    (2 * t3 - 3 * t2 + 1) * p0 +
    (t3 - 2 * t2 + t) * w +
    (-2 * t3 + 3 * t2) * p1 +
    (t3 - t2) * w * m1
  )
}

/**
 * 検出レベル(`duckDetectorLevel`)から BGM に掛ける倍率を出す静特性。
 * `sidechaincompress` と同じく knee 区間(しきい値の前後 √knee 倍)は
 * エルミート補間でなだらかに潰す。knee の下端以下は 1(素通し)。
 */
export function duckGainForLevel(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 1
  const kneeStartLin = DUCKING.threshold / Math.sqrt(DUCKING_KNEE)
  if (level <= kneeStartLin) return 1
  const slope = Math.log(level)
  const thres = Math.log(DUCKING.threshold)
  const kneeStart = Math.log(kneeStartLin)
  const kneeStop = Math.log(DUCKING.threshold * Math.sqrt(DUCKING_KNEE))
  const gainLog =
    slope > kneeStop
      ? (slope - thres) / DUCKING.ratio + thres
      : hermite(
          slope,
          kneeStart,
          kneeStop,
          kneeStart,
          (kneeStop - thres) / DUCKING.ratio + thres,
          1 / DUCKING.ratio
        )
  return Math.exp(gainLog - slope)
}

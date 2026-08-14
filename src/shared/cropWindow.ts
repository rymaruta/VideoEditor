/**
 * スマートクロップの「どこを切り抜くか」を決める部分。
 *
 * エネルギー分布（列ごと・行ごとの強さ）を受け取り、切り抜き窓の中心を
 * 0〜1 の割合で返す。ffmpeg に触らない純粋な計算なので単体で測れる。
 */

/**
 * 同点判定の相対誤差。エネルギーは複数フレームの平均（浮動小数）なので、
 * 同じ列の集合を含む窓でも合計が最下位ビットだけずれる。ULP 数個分を
 * 吸収できればよいので 1e-9。
 */
const TIE_TOLERANCE = 1e-9

/**
 * エネルギー合計が最大になる窓の中心を返す（0〜1）。
 *
 * 合計が最大の窓は一つとは限らない。被写体が窓より細いとき（切り抜き窓は
 * 素材の 3 割程度なので、これが普通）、被写体を丸ごと含む窓は全部同点になる。
 * その中から先頭を選ぶと被写体が窓の右端に寄る。
 *
 * そこで、同点が続く区間が捉えているエネルギーの重心を求め、その重心に窓の
 * 中心を合わせる（素材からはみ出す分だけ内側に寄せる）。同点の窓が離れて
 * 複数箇所にあるときは先頭の区間を使う。二つの山の谷間を選ばないため。
 */
export function bestWindowCenter(energy: number[], windowFraction: number): number {
  const n = energy.length
  if (n === 0) return 0.5
  if (!Number.isFinite(windowFraction) || windowFraction <= 0) return 0.5
  const windowSize = Math.min(n, Math.max(1, Math.round(n * windowFraction)))
  if (windowSize >= n) return 0.5

  // prefix: エネルギーの累積和 / weighted: 位置で重み付けした累積和（重心用）。
  // 列 i が占める範囲は [i, i+1) なので、位置は中心の i + 0.5 で数える。
  const prefix = new Array<number>(n + 1).fill(0)
  const weighted = new Array<number>(n + 1).fill(0)
  for (let i = 0; i < n; i++) {
    const value = Number.isFinite(energy[i]) ? energy[i] : 0
    prefix[i + 1] = prefix[i] + value
    weighted[i + 1] = weighted[i] + value * (i + 0.5)
  }

  const lastStart = n - windowSize
  const windowSum = (start: number): number => prefix[start + windowSize] - prefix[start]
  let bestSum = -Infinity
  for (let start = 0; start <= lastStart; start++) {
    if (windowSum(start) > bestSum) bestSum = windowSum(start)
  }

  // 同点が続く先頭の区間 [runStart, runEnd] を取る。
  const floor = bestSum - Math.abs(bestSum) * TIE_TOLERANCE
  let runStart = 0
  while (runStart <= lastStart && windowSum(runStart) < floor) runStart++
  let runEnd = runStart
  while (runEnd < lastStart && windowSum(runEnd + 1) >= floor) runEnd++

  // その区間の窓が通る範囲全体で重心を求める。
  const from = runStart
  const to = runEnd + windowSize
  const total = prefix[to] - prefix[from]
  const half = windowSize / 2
  // エネルギーが全く無い（真っ黒など）なら寄せる先が無いので素材の中央。
  const centroid = total > 0 ? (weighted[to] - weighted[from]) / total : n / 2
  return Math.min(n - half, Math.max(half, centroid)) / n
}

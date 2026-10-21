/**
 * 速さの試験の時間の上限。CI の Windows の機械はこの開発環境より約7倍遅い(実測: 2,000 クリップの
 * 本編の対応 95ms → 650〜730ms、複製 100ms → 730ms)ので、CI では上限を7倍にする。
 * どの試験も、守りたい退行(総当たりに戻る・並べ直しを繰り返す)は手元でも上限の数倍かかるので、
 * 7倍にしても退行は見逃さない
 */
export const PERF_SLOWDOWN = process.env.CI ? 7 : 1

export function perfBudget(ms: number): number {
  return ms * PERF_SLOWDOWN
}

/**
 * **境界値をサボらせないための道具。**
 *
 * 実装ルールは「0・空・最大・負・NaN・Infinity を必ず当てる」だが、手で並べると
 * 必ずどれかが抜ける。数を受け取る関数は**この一覧を全部**通し、「落ちない」
 * 「有限な値を返す」「約束した範囲に収まる」を機械的に確かめる。
 */
export const NASTY_NUMBERS: readonly number[] = [
  0,
  -0,
  1,
  -1,
  0.1,
  -0.1,
  1e-9,
  -1e-9,
  0.5,
  2,
  1000,
  -1000,
  Number.MIN_VALUE,
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
  Number.EPSILON,
  NaN,
  Infinity,
  -Infinity
]

/** 数以外で来うるもの(外から読んだ JSON には何でも入っている) */
export const NASTY_VALUES: readonly unknown[] = [
  undefined,
  null,
  '',
  '0',
  'abc',
  true,
  false,
  {},
  [],
  [1, 2],
  (): number => 0
]

/** 決まった種から作る乱数。**毎回同じ順で回る**ので、落ちたら必ず再現できる。 */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

/** `lo`〜`hi` の乱数。ときどき異常値を混ぜる。 */
export function fuzzNumber(rnd: () => number, lo: number, hi: number): number {
  const r = rnd()
  if (r < 0.03) return NaN
  if (r < 0.06) return Infinity
  if (r < 0.09) return -Infinity
  return lo + rnd() * (hi - lo)
}

/**
 * 小数の誤差を丸めて比べるための桁揃え。
 *
 * **桁あふれに注意。** 素朴に `Math.round(n * 1e6) / 1e6` と書くと、
 * `Number.MAX_VALUE` を渡したときに掛け算で Infinity になり、
 * **有限の入力から無限が返る**——計器自身がテストを落とす原因になる。
 * (実際、この一行で「有限を返すはず」の検査が誤って落ちた)
 */
export function round(n: number, digits = 6): number {
  if (!Number.isFinite(n)) return n
  const f = 10 ** digits
  const scaled = n * f
  if (!Number.isFinite(scaled)) return n
  return Math.round(scaled) / f
}

/**
 * 高速フーリエ変換(基数2・その場で計算)。同期の相互相関に使う。
 *
 * 長尺(4時間)の音の包絡線どうしを相関させるので、素直な O(n²) では間に合わない
 * (100Hz の包絡線で 144万点 × 144万点)。FFT なら O(n log n) で数百ミリ秒に収まる。
 */

export function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/** re/im をその場で変換する。長さは2のべき乗であること。`inverse` なら逆変換(1/N も掛ける) */
export function fftInPlace(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length
  if (n !== im.length || (n & (n - 1)) !== 0) throw new Error('FFT の長さは2のべき乗にしてください')
  // ビット反転の並べ替え
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]
        const aIm = im[i + k]
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe
        re[i + k] = aRe + bRe
        im[i + k] = aIm + bIm
        re[i + k + half] = aRe - bRe
        im[i + k + half] = aIm - bIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

/**
 * 相互相関 c[k] = Σ a[t + k]·b[t] を、k = -(b.length-1) 〜 a.length-1 の全範囲で求める。
 * 戻り値の添字 i は k = i - (b.length - 1)。
 * `phat` なら周波数ごとの大きさで割る(GCC-PHAT。鋭い山になり、細かい位置合わせに向く)。
 */
export function crossCorrelation(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  phat = false
): Float64Array {
  const n = nextPow2(a.length + b.length)
  const aRe = new Float64Array(n)
  const aIm = new Float64Array(n)
  const bRe = new Float64Array(n)
  const bIm = new Float64Array(n)
  for (let i = 0; i < a.length; i++) aRe[i] = a[i]
  for (let i = 0; i < b.length; i++) bRe[i] = b[i]
  fftInPlace(aRe, aIm)
  fftInPlace(bRe, bIm)
  // A · conj(B)
  for (let i = 0; i < n; i++) {
    const re = aRe[i] * bRe[i] + aIm[i] * bIm[i]
    const im = aIm[i] * bRe[i] - aRe[i] * bIm[i]
    if (phat) {
      const mag = Math.hypot(re, im)
      aRe[i] = mag > 1e-12 ? re / mag : 0
      aIm[i] = mag > 1e-12 ? im / mag : 0
    } else {
      aRe[i] = re
      aIm[i] = im
    }
  }
  fftInPlace(aRe, aIm, true)
  const out = new Float64Array(a.length + b.length - 1)
  for (let i = 0; i < out.length; i++) {
    const k = i - (b.length - 1)
    out[i] = aRe[k >= 0 ? k : n + k]
  }
  return out
}

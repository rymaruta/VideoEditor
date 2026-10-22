/**
 * 波形を二重(外側に山・内側に平均)に描くための純関数。
 *
 * **canvas は一定幅のタイルに分けて描く。** Chromium の canvas は一辺が 65,535px を超えると
 * 例外も出さずに何も描かない(拡大率 1 で約 27 分、最大拡大で約 6.8 分を超えるクリップの
 * 波形が丸ごと消えていた)。タイルにすれば、どんなに長いクリップでも一枚は上限を超えない。
 * 描くのは画面に見えているタイルだけにして、長い素材をズーム・トリムしても固まらないようにする。
 */

/** タイル 1 枚の幅(px)。見えている幅(画面 1 枚ぶん)より少し広い程度 */
export const WAVEFORM_TILE_WIDTH = 2048

/** Chromium の canvas の一辺の上限(これを超えると何も描かれない) */
export const CANVAS_MAX_SIDE = 65535

/** 外側の山を、まわりの何列ぶんの大きい方で取るか。広げすぎると音の出始め・終わりが太って時刻がずれて見える */
export const PEAK_REACH = 1

/** 「塗られている」とみなす不透明度(ffmpeg の絵の縁のにじみを拾わない) */
const ALPHA_THRESHOLD = 24

export interface WaveTile {
  /** 絵の中の左端(px) */
  x: number
  /** 幅(px) */
  w: number
}

/** 幅 `total` の絵を、`tile` 幅ずつのタイルに分ける(最後の 1 枚は残りの幅) */
export function waveformTiles(total: number, tile: number = WAVEFORM_TILE_WIDTH): WaveTile[] {
  const width = Math.max(0, Math.round(total))
  const step = Math.max(1, Math.min(Math.round(tile), CANVAS_MAX_SIDE))
  const tiles: WaveTile[] = []
  for (let x = 0; x < width; x += step) tiles.push({ x, w: Math.min(step, width - x) })
  return tiles
}

/**
 * タイルを描くのに読む範囲。外側の山はまわり `reach` 列を見るので、左右に `reach` だけ
 * はみ出して読む(タイルの境目で山が欠けない)。`offset` は読んだ範囲の中でタイルが始まる位置
 */
export function tileReadRange(
  tile: WaveTile,
  total: number,
  reach: number = PEAK_REACH
): { sx: number; sw: number; offset: number } {
  const sx = Math.max(0, tile.x - reach)
  const end = Math.min(Math.round(total), tile.x + tile.w + reach)
  return { sx, sw: Math.max(0, end - sx), offset: tile.x - sx }
}

/**
 * 列ごとの音の大きさ(中心からの高さ, px)を、ffmpeg の絵(RGBA)から読む。
 * 絵は `showwavespic` の既定(列ごとの平均)で、中心から上下へ対称に塗られている。
 */
export function columnLevels(rgba: ArrayLike<number>, w: number, h: number): Float32Array {
  const levels = new Float32Array(w)
  const center = (h - 1) / 2
  for (let x = 0; x < w; x++) {
    let top = -1
    let bottom = -1
    for (let y = 0; y < h; y++) {
      if (rgba[(y * w + x) * 4 + 3] > ALPHA_THRESHOLD) {
        if (top < 0) top = y
        bottom = y
      }
    }
    levels[x] = top < 0 ? 0 : Math.max(center - top, bottom - center) + 0.5
  }
  return levels
}

/** 外側の山: 各列について、まわり `reach` 列のうち大きい方 */
export function peakEnvelope(levels: Float32Array, reach: number = PEAK_REACH): Float32Array {
  const out = new Float32Array(levels.length)
  for (let x = 0; x < levels.length; x++) {
    let peak = levels[x]
    for (let k = 1; k <= reach; k++) {
      if (x - k >= 0 && levels[x - k] > peak) peak = levels[x - k]
      if (x + k < levels.length && levels[x + k] > peak) peak = levels[x + k]
    }
    out[x] = peak
  }
  return out
}

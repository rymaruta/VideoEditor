import type { AspectRatio, ResolutionHeight } from './types'

/**
 * 書き出しの出力サイズ。`standard` は短辺(9:16なら幅、16:9なら高さ)。
 *
 * プレビューのテロップも同じ値で換算する必要があるため、書き出し側だけが持っていると
 * 片方を直したときに黙ってズレる。main と renderer の共通の置き場に置く。
 */
export function targetResolution(
  aspectRatio: AspectRatio,
  standard: ResolutionHeight
): { w: number; h: number } {
  const longSide = Math.round((standard * 16) / 9 / 2) * 2
  if (aspectRatio === '9:16') {
    return { w: standard, h: longSide }
  }
  return { w: longSide, h: standard }
}

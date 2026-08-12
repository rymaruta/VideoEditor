/**
 * 波形画像を「どの解像度で作るか」の決め方。
 *
 * 帯の実寸(px)をそのまま渡すと、パネルをドラッグしている間じゅう幅が1pxずつ変わり、
 * そのたびに ffmpeg を起こすことになる。かといって固定幅にすると、帯が広いときは
 * 引き伸ばされてぼやけ、狭いときは無駄に細かい画像を作る。
 * **実寸から決めるが、刻みを持たせて作り直しの回数を抑える**のが狙い。
 */

/** 幅の刻み。これ未満の変化では作り直さない */
export const WAVEFORM_WIDTH_STEP = 20
/** これより狭い帯には描かない(潰れて読めないうえ、生成の意味がない) */
export const WAVEFORM_MIN_WIDTH = 40
/** 画面より極端に大きい画像を作らないための上限 */
export const WAVEFORM_MAX_WIDTH = 2000
/** 生成側(`generateWaveformDataUrl`)の下限と合わせる */
export const WAVEFORM_MIN_HEIGHT = 10

export interface WaveformSize {
  width: number
  height: number
}

/**
 * 帯の実寸から、波形生成に使うサイズを決める。描くべきでないときは `null`。
 *
 * 幅は刻みへ切り上げるので、パネルを少し動かした程度では同じ値になり、
 * `Waveform` の再フェッチ(props 変化がきっかけ)が走らない。
 */
export function waveformRenderSize(
  measuredWidth: number,
  measuredHeight: number
): WaveformSize | null {
  if (!Number.isFinite(measuredWidth) || !Number.isFinite(measuredHeight)) return null
  if (measuredWidth < WAVEFORM_MIN_WIDTH || measuredHeight <= 0) return null
  const stepped = Math.ceil(measuredWidth / WAVEFORM_WIDTH_STEP) * WAVEFORM_WIDTH_STEP
  return {
    width: Math.min(WAVEFORM_MAX_WIDTH, stepped),
    height: Math.max(WAVEFORM_MIN_HEIGHT, Math.round(measuredHeight))
  }
}

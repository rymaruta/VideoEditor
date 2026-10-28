/**
 * 画面の配置の既定(覚えた寸法が無いときだけ使う)。
 */

/**
 * タイムラインのパネルが、ふつうの企画(本編・ワイプ 1・音 3・テロップ 1)のレーンを全部見せるのに
 * 要る高さ(見出し 40・目盛り 31・本編 63・ワイプ 45・音 53×3・テロップ 33・トラックを足すボタン 40・
 * 余白)。これより低いとテロップのレーンが下に切れていた(既定 420px)
 */
export const TIMELINE_LANES_HEIGHT = 480

/** 下段(タイムライン)に使ってよいのは、パネルに使える高さの半分まで(モニターを小さくしすぎない) */
export const BOTTOM_SHARE = 0.5

/**
 * 下段の既定の高さ。レーンが全部見える高さを目指し、低い窓ではモニターに半分を残す。
 * 1366×768 で 1920×1080 と同じ 420px を取ると、モニターの絵が 190×107px まで縮んでいた
 */
export function defaultBottomHeight(
  windowHeight: number,
  chromeHeight: number,
  minBottom: number
): number {
  const available = Math.max(0, windowHeight - chromeHeight)
  return Math.max(minBottom, Math.min(TIMELINE_LANES_HEIGHT, Math.round(available * BOTTOM_SHARE)))
}

/** これより狭い窓では、素材とインスペクタを細くする */
export const NARROW_WINDOW_WIDTH = 1440

/** 左のパネル(素材)と右のインスペクタの既定の幅。1440 未満の窓では 240・280(プログラムを広く残す) */
export function defaultSideWidths(windowWidth: number): { left: number; right: number } {
  return windowWidth < NARROW_WINDOW_WIDTH ? { left: 240, right: 280 } : { left: 288, right: 312 }
}

/**
 * タイムラインの中身の高さ: パネルの中のトラック以外(道具の帯など)+ 見出しの列・レーンの列の高い方
 * (レーンの列は横のスクロールバーを含む)
 */
export function timelineNaturalHeight(m: {
  panelHeight: number
  tracksClientHeight: number
  labelsHeight: number
  lanesHeight: number
}): number {
  const chrome = Math.max(0, m.panelHeight - m.tracksClientHeight)
  return Math.ceil(chrome + Math.max(m.labelsHeight, m.lanesHeight))
}

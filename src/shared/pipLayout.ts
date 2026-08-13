/**
 * PiP(ワイプ)を隅からどれだけ離すか。
 *
 * **フレームの幅**に対する比で、上下にも同じピクセル数を使う(隅からの距離を四辺で揃える)。
 * 縦方向を「高さの◯%」にすると、同じ設定でも縦横比によって隅からの距離が変わる。
 *
 * 書き出し(ffmpeg の `overlay`)とプレビュー(CSS)で別々に書くと黙ってズレるので、
 * **規則はここ1箇所だけに置き、両方がこの関数を呼ぶ**。
 * CSS の `top`/`bottom` に `%` を書くと**親の高さ**基準になってしまうため、
 * プレビュー側は枠の実寸(幅)から px を求めて渡すこと。
 * (実測: 16:9・1080p で書き出すと下の余白は高さの 7.22% なのに、プレビューでは 4% で
 * 描かれていた。9:16 では逆に書き出し 2.29% / プレビュー 4% と、縦横比で向きが変わる)
 */
export const PIP_MARGIN_RATIO = 0.04

/** フレームの幅から、PiP を隅から離す余白(ピクセル)を求める */
export function pipMarginPx(frameWidth: number): number {
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) return 0
  return frameWidth * PIP_MARGIN_RATIO
}

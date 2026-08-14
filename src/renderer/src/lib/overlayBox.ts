import type { CSSProperties } from 'react'
import { TEXT_BOX_PADDING_H_EM, TEXT_BOX_PADDING_V_EM } from '@shared/textStyle'
import type { TextStyle } from '@shared/types'

/** `#rrggbb` と不透明度を CSS の色にする。読めない値は黒・不透明として扱う。 */
function hexToRgba(hex: string, alpha: number): string {
  const clean = typeof hex === 'string' ? hex.replace('#', '') : ''
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  const n = (v: number): number => (Number.isFinite(v) ? v : 0)
  // 不透明度は 0〜1。プロジェクトファイルは外から来るので、NaN や範囲外を素通りさせない
  // (`rgba(...)` に NaN が1つ入ると宣言ごと無効になり、**箱が丸ごと消える**)。
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1
  return `rgba(${n(r)}, ${n(g)}, ${n(b)}, ${a})`
}

/**
 * 背景箱の見た目。**外側の位置決めの箱ではなく、文字を包む内側の要素**に付ける。
 *
 * 外側は `left` と `right` を**両方**指定している(折り返す幅＝書き出しの `MarginL/R` と
 * 同じ比)。幅が確定しているので、そこへ背景を塗ると `inline-block` にしても
 * **文字の量と無関係に枠いっぱいの帯**になる。一方、書き出し(libass の BorderStyle=3)は
 * **文字を囲む箱**なので、同じ設定でも見た目が別物になっていた。
 * 実測(9:16・枠 402x714px・1文字「あ」・背景ON): 画面の箱は **362px = 枠の 90.05%** で、
 * 文字サイズ 20 でも 80 でも**同じ 90.05%**(高さだけは 1.68% → 6.58% と付いてきていた)。
 * 同じテロップを書き出すと箱は **64px = 5.93%** で、**15.2倍**の開きがあった。
 *
 * `display: inline` にするのが肝心。`inline-block` だと**折り返しても箱は1つ**になるが、
 * libass は**行ごとに箱を描く**。`box-decoration-break: clone` を付けて、折り返した各行に
 * 同じ余白の箱が付くようにする(付けないと左右の余白が最初と最後の行にしか付かない)。
 *
 * 余白は `em`。文字サイズに対する比なので、書き出しの `\xbord`/`\ybord`
 * (`textBoxPaddingPx`)と**同じ数字**(`@shared/textStyle`)から出していることになる。
 * ここに px を書くと、プレビュー枠の大きさが変わった瞬間に書き出しとズレる。
 */
export function overlayBoxStyle(style: TextStyle): CSSProperties | undefined {
  if (!style.background) return undefined
  return {
    backgroundColor: hexToRgba(style.backgroundColor, style.backgroundOpacity),
    padding: `${TEXT_BOX_PADDING_V_EM}em ${TEXT_BOX_PADDING_H_EM}em`,
    borderRadius: '4px',
    display: 'inline',
    WebkitBoxDecorationBreak: 'clone',
    boxDecorationBreak: 'clone'
  }
}

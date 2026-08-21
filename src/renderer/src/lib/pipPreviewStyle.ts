import type { CSSProperties } from 'react'
import { pipMarginPx } from '@shared/pipLayout'
import type { PipPosition } from '@shared/types'

/**
 * PiP を縁取る白い線の太さ(px)。**書き出しには無い、画面だけの飾り。**
 *
 * **`border` で描いてはいけない。** `box-sizing: border-box` が全体に掛かっているので、
 * `width: ${scale * 100}%` の中へ線のぶんが食い込み、**絵そのものが左右合わせて 4px 縮む**。
 * 縮む量は常に 4px なので、**枠が小さいほど・ワイプが小さいほど割合が大きく**なる。
 * しかも隅からの距離は逆に 2px 広がる——共有の `pipMarginPx` が守っているのは
 * 「線の外側」であって「**絵の位置**」ではない。
 *
 * (実測・素材 320x240 のワイプを右下に置き、書き出した画の画素と突き合わせ。
 *  書き出しは**どの条件でも幅 0.30000・余白 0.04063**:
 *
 *  | 企画 / つまみ | 画面の絵の割合 | 絵が小さい率 | 画面の余白 |
 *  |---|---|---|---|
 *  | 16:9 / 0.50 | 0.49046 | 1.91% | 0.04473 |
 *  | 16:9 / 0.30 | 0.29048 | 3.17% | 0.04473 |
 *  | 16:9 / 0.15 | 0.14046 | 6.36% | 0.04473 |
 *  | 9:16 / 0.30 | 0.26992 | **10.03%** | 0.05499 |
 *  | 9:16 / 0.15 | 0.11986 | **20.09%** | 0.05499 |
 *
 *  枠は 16:9 が 420.3px なのに 9:16 は **133.0px** しかないので、同じ 4px でも
 *  効き方が5倍違う。**ショート(9:16)で小さめのワイプを使うほど外れる**)
 *
 * レイアウトに一切参加しない `box-shadow` の広がりで描く。角丸にもそのまま沿う。
 * 同じ理由で、テロップの選択枠は `outline`、背景箱の余白は `em` になっている。
 */
export const PIP_RING_PX = 2

/** 画面だけの角丸。絵の位置は動かさない */
export const PIP_RADIUS_PX = 8

/**
 * プレビューの PiP(ワイプ)の箱。
 *
 * **ここで決まるのは「絵」の位置と大きさ**で、書き出しの
 * `scale=${w * track.scale}` / `overlay=x=W-w-${pipMarginPx(w)}` と**同じ規則**でなければ
 * ならない。飾り(白い輪・角丸・落ち影)は箱の外に描くこと。
 *
 * 隅からの余白は**枠の幅**基準(書き出しと同じ規則)。CSS の `top`/`bottom` に `%` を書くと
 * **親の高さ**基準になり、同じ設定でも縦横比によって書き出しとズレる。
 *
 * @param frameWidth プレビュー枠の実寸(px)。余白が幅基準なので px で渡す。
 *   0 のときは 0px = 隅に付く(初回描画の1フレームだけで、`ResizeObserver` が
 *   測ったらすぐ追従する)。
 */
export function pipPreviewStyle(
  position: PipPosition,
  scale: number,
  frameWidth: number
): CSSProperties {
  const margin = pipMarginPx(frameWidth)
  const style: CSSProperties = {
    position: 'absolute',
    width: `${scale * 100}%`,
    height: 'auto',
    borderRadius: PIP_RADIUS_PX,
    boxShadow:
      `0 0 0 ${PIP_RING_PX}px rgba(255, 255, 255, 0.8), ` + '0 4px 16px rgba(0, 0, 0, 0.5)',
    zIndex: 2
  }
  if (position === 'top-left' || position === 'top-right') style.top = margin
  else style.bottom = margin
  if (position === 'top-left' || position === 'bottom-left') style.left = margin
  else style.right = margin
  return style
}

import { cropObjectPosition } from '@shared/videoFrame'

/**
 * 「クロップして画面いっぱいに表示」を `<video>` の CSS へ落とす。
 *
 * 書き出しは `scaleToFrameFilter` が枠を覆うまで拡大してから切り抜くので、画面も
 * `object-fit: cover` + 切り取り位置で同じ絵にする。切っていないときは `contain`
 * (枠に収めて黒帯)で、これも書き出しと同じ。
 *
 * **プレビューとトリムのモーダルで同じ関数を呼ぶための置き場。** 式を書き写すと、
 * 片方だけ直したときに「画面では切れているのにモーダルでは切れていない」といった
 * 食い違いが黙って生まれる(実際、モーダルは素材そのままを出していて、
 * クロップを入れても適用するまで1画素も変わらなかった)。
 */
export function cropPreviewStyle(
  sourceAspect: number,
  targetAspect: number,
  fillCrop: boolean | undefined,
  cropCenter?: { x: number; y: number }
): { objectFit: 'contain' | 'cover'; objectPosition?: string } {
  if (!fillCrop) return { objectFit: 'contain' }
  const pos = cropObjectPosition(sourceAspect, targetAspect, cropCenter)
  return { objectFit: 'cover', objectPosition: `${pos.x * 100}% ${pos.y * 100}%` }
}

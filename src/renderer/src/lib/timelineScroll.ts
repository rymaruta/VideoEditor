/**
 * 追従したあと、再生位置を表示幅のどのあたりに置くか(左からの割合)。
 * 左端ぴったりに寄せると直前の数秒が見えなくなるので少し余白を残す。
 */
const LEAD_RATIO = 0.15

/** 端からこの距離以内に入ったら「はみ出した」とみなす(px) */
const EDGE_MARGIN_PX = 24

/**
 * 再生位置がタイムラインの表示範囲から出たときの、新しい `scrollLeft` を返す。
 * スクロールする必要がなければ `null`。
 *
 * 再生中は毎フレーム呼ばれるので、**範囲内にいる間は必ず `null` を返す**
 * (毎フレーム `scrollLeft` に書き込むと、追従のたびにレイアウトが走って重くなる)。
 * はみ出したときだけページ送りするので、書き込みは画面1つぶんに1回で済む。
 */
export function autoScrollLeft(view: {
  /** レーン先頭からの再生位置(px) */
  playheadX: number
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
}): number | null {
  const { playheadX, scrollLeft, clientWidth, scrollWidth } = view
  if (![playheadX, scrollLeft, clientWidth, scrollWidth].every((v) => Number.isFinite(v))) {
    return null
  }
  if (clientWidth <= 0) return null
  const maxScroll = scrollWidth - clientWidth
  // 横スクロールできない(レーンが表示幅に収まっている)なら何もしない
  if (maxScroll <= 0) return null

  // 表示幅が極端に狭いときに余白が幅を食い潰さないようにする
  const margin = Math.min(EDGE_MARGIN_PX, clientWidth / 4)
  if (playheadX >= scrollLeft + margin && playheadX <= scrollLeft + clientWidth - margin) {
    return null
  }

  const target = Math.min(maxScroll, Math.max(0, playheadX - clientWidth * LEAD_RATIO))
  // 終端まで来ていて、これ以上動かせない場合は書き込まない
  return Math.abs(target - scrollLeft) < 1 ? null : target
}

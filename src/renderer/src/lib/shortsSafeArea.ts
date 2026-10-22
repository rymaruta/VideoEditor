import { SHORTS_UI_BAND_BOTTOM, SHORTS_UI_BAND_TOP, SHORTS_UI_RAIL } from '@shared/telop/stack'

/**
 * YouTube Shorts の画面UIに**隠れない範囲**(セーフエリア)の目安。
 *
 * 投稿画面には、こちらの動画の上に YouTube 自身のUIが重なる。
 * ところが**このアプリの既定のテロップ位置は、その帯の内側に入る**。
 * (実測・9:16 / 実サイズ表示 402x714px / 既定スタイルのテロップ1枚:
 *  テロップの字面は高さの **89.4%〜91.7%**、Shorts UI の下部帯は **84.4%〜94.0%** で、
 *  **字面が帯に完全に入る**。右側のUI(いいね・コメント等)は横 **88.5%〜97%**・
 *  縦 46%〜82% にあり、19文字のセンター配置テロップは字面が 85.7% まで伸びていた)
 *
 * **数字を動かすと既存プロジェクトの見た目が一斉に変わる**ので、余白そのものは変えない。
 * 代わりにこの線をプレビューへ出して、隠れる位置に置いていることが**作っている最中に
 * 分かる**ようにする。線は画面だけのもので、**書き出しには1画素も影響しない**。
 *
 * 値は上の実測から、帯の側に少し余裕を持たせて丸めたもの。帯・右の列の位置は
 * `@shared/telop/stack` の定数(書き出しで発言テロップを上げる位置と同じ所)にまとめ、
 * `ShortsUiMockup` もそこから置く(`shortsUiMockupLayout`)。
 */

/** これより下は下部帯(チャンネル名・説明文・楽曲)に隠れやすい */
export const SHORTS_SAFE_BOTTOM_RATIO = SHORTS_UI_BAND_TOP
/** これより右は右列のUI(いいね・コメント・共有)に隠れやすい */
export const SHORTS_SAFE_RIGHT_RATIO = 0.88
/** これより上は上部のバッジ(ショート/ライブなど)に隠れやすい */
export const SHORTS_SAFE_TOP_RATIO = 0.05

/**
 * 目安線の内側(=安全に文字を置ける範囲)を CSS の inset で返す。
 * プレビュー枠に対する割合なので、枠の大きさが変わっても同じ比のまま。
 */
export function shortsSafeAreaInset(): {
  top: string
  right: string
  bottom: string
  left: string
} {
  return {
    top: `${SHORTS_SAFE_TOP_RATIO * 100}%`,
    right: `${(1 - SHORTS_SAFE_RIGHT_RATIO) * 100}%`,
    bottom: `${(1 - SHORTS_SAFE_BOTTOM_RATIO) * 100}%`,
    // 左は隠すUIが無いので、右と同じ見た目になる分だけ空ける
    left: `${(1 - SHORTS_SAFE_RIGHT_RATIO) * 100}%`
  }
}

const pct = (r: number): string => `${Math.round(r * 100000) / 1000}%`

/**
 * プレビューに重ねる Shorts の画面イメージの、帯と右の列の置き場所(プレビュー枠に対する割合)。
 * 実際の比率で置くので、プレビューの大きさが変わっても帯は高さの 84〜94% に来る
 * (中の文字・アイコンの大きさは CSS でプレビューの高さに比例させる)
 */
export function shortsUiMockupLayout(): {
  band: { top: string; height: string; left: string; right: string }
  rail: { top: string; height: string; left: string; right: string }
} {
  return {
    band: {
      top: pct(SHORTS_UI_BAND_TOP),
      height: pct(SHORTS_UI_BAND_BOTTOM - SHORTS_UI_BAND_TOP),
      left: '3%',
      // 説明文は右の列の手前まで
      right: pct(1 - SHORTS_UI_RAIL.left + 0.02)
    },
    rail: {
      top: pct(SHORTS_UI_RAIL.top),
      height: pct(SHORTS_UI_RAIL.bottom - SHORTS_UI_RAIL.top),
      left: pct(SHORTS_UI_RAIL.left),
      right: pct(1 - SHORTS_UI_RAIL.right)
    }
  }
}

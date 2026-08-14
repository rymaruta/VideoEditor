import type { AspectRatio } from './types'

/**
 * 書き出しの出力サイズ。`standard` は短辺(9:16なら幅、16:9なら高さ)で、偶数を渡すこと。
 *
 * プレビューのテロップも同じ値で換算する必要があるため、書き出し側だけが持っていると
 * 片方を直したときに黙ってズレる。main と renderer の共通の置き場に置く。
 *
 * 短辺は `ResolutionHeight` に限定しない。書き出し以外にも**同じ画角で撮りたい**ものが
 * あり(サムネ候補は短辺720、生成AIへ渡す絵は短辺320)、そこで型が合わないからと
 * 各自が `* 16 / 9` を書き写すと、画角の規則が3箇所に散る。
 */
export function targetResolution(
  aspectRatio: AspectRatio,
  standard: number
): { w: number; h: number } {
  const longSide = Math.round((standard * 16) / 9 / 2) * 2
  if (aspectRatio === '9:16') {
    return { w: standard, h: longSide }
  }
  return { w: longSide, h: standard }
}

/**
 * テロップを描く仮想キャンバス(ASS の PlayResX/PlayResY)の短辺。
 *
 * ここを**出力解像度に合わせてはいけない**。合わせると `\fs` / `MarginL/R` / `\bord` に
 * 入れた数字がそのまま出力ピクセルになり、**解像度を変えるとレイアウトが変わる**。
 * 実測(既定スタイルのサイズ40・長めの一文): 文字の絶対幅は4解像度とも 865px で同じため、
 * 枠に対する比が 480p で **101%(左右が切れる)**、1080p で 45.1%、4K で 22.5% と
 * ばらばらだった。libass は PlayRes から実際のフレームへ全体を拡大縮小するので、
 * **キャンバスを固定すれば中の数字は自動的に「枠に対する比」になる。**
 *
 * 値が 1080 なのは既定の書き出し解像度だから。こうすると既定のまま書き出した場合は
 * 従来と**まったく同じ ASS** になり、保存済みプロジェクトの見た目が動かない
 * (`fontSize` の意味を変えずに済むので、値の読み替えも要らない)。
 */
export const TEXT_CANVAS_STANDARD = 1080

/** テロップの仮想キャンバスの大きさ。書き出しとプレビューが必ず同じ値を使うための共通の置き場。 */
export function textCanvasSize(aspectRatio: AspectRatio): { w: number; h: number } {
  return targetResolution(aspectRatio, TEXT_CANVAS_STANDARD)
}

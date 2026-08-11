/**
 * 映像を出力枠(w x h)に収める ffmpeg フィルタ。
 *
 * 書き出しとサムネイル生成で同じ式を使う。別々に書くと、片方だけ直したときに
 * **書き出した映像とサムネイルの画角が黙って食い違う**(実際、サムネイル側は
 * pad しか持っておらず、fillCrop を付けたクリップでも黒帯のままだった)。
 *
 * - `fillCrop` あり: 枠を埋めるまで拡大してから切り抜く(黒帯なし)。
 *   `cropCenter` は素材内の 0〜1 の位置。切り抜き窓が素材からはみ出さないよう
 *   ffmpeg 側の式で 0〜(素材サイズ-窓サイズ) に収めている。
 * - `fillCrop` なし: 収まるまで縮小して余白を黒で埋める。
 */
export function scaleToFrameFilter(
  w: number,
  h: number,
  fillCrop?: boolean,
  cropCenter?: { x: number; y: number }
): string {
  if (!fillCrop) {
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
  }
  const cx = cropCenter?.x ?? 0.5
  const cy = cropCenter?.y ?? 0.5
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:'min(max(0,(iw*${cx}-ow/2)),(iw-ow))':'min(max(0,(ih*${cy}-oh/2)),(ih-oh))'`
}

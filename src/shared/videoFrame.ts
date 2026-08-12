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
 * - `fillCrop` なし + `blurBackground`: 余白を黒ではなく、素材を枠いっぱいに
 *   広げてぼかしたもので埋める。`fillCrop` がONなら余白自体が無いので効かない。
 */
/**
 * ぼかしの強さ(ガウスの標準偏差)を出力の高さから決める。
 * 数値でない高さは下限に倒す。`gblur=sigma=NaN` は ffmpeg が受け付けず、
 * **書き出し自体が失敗する**(画面には「解析に失敗しました」としか出ない)。
 */
export function blurSigmaFor(h: number): number {
  if (!Number.isFinite(h)) return MIN_BLUR_SIGMA
  return Math.max(MIN_BLUR_SIGMA, Math.round(h / 60))
}

const MIN_BLUR_SIGMA = 8

export function scaleToFrameFilter(
  w: number,
  h: number,
  fillCrop?: boolean,
  cropCenter?: { x: number; y: number },
  blurBackground?: boolean,
  options: {
    /**
     * 中間ラベルの接尾辞。filter_complex はグラフ全体で1つの名前空間なので、
     * クリップごとに違う値を渡さないと**同じラベルが二重定義されて書き出しごと失敗する**。
     */
    labelSuffix?: string
    /**
     * 出力のフレームレート。**`fps` はこの関数の中で付ける**(呼び出し側で付けない)。
     *
     * ぼかし背景は `overlay` で2系統を合成する。`overlay` は2入力のタイミングを
     * 突き合わせる(framesync)ため、**その後ろに `fps` を置くと最後の1フレームが
     * 落ちて映像だけ短くなる**。実測: 25fps素材を30fpsで6秒書き出すと、映像
     * 5.967秒(179フレーム)に対して音声 6.000秒。合成の前に両系統を揃え、
     * `overlay` の後ろには置かない形にすると 6.000秒(180フレーム)で一致する。
     * 静止画1枚の生成では不要なので省略してよい。
     */
    fps?: number
  } = {}
): string {
  const labelSuffix = options.labelSuffix ?? ''
  const fps = options.fps
  const fpsPart = fps ? `,fps=${fps}` : ''
  if (!fillCrop && blurBackground) {
    // 同じ入力を2つに分け、片方を枠いっぱいに広げてぼかした背景に、
    // もう片方を収まるように縮めた前景として重ねる。
    // `,` でつながる1本のチェーンには収まらないので、`;` で区切った部分グラフを返す。
    // 呼び出し側は `[N:v]<前>${this},<後>[out]` の形で埋め込むため、先頭は split から
    // 始まり、末尾は overlay(出力ラベルなし)で終わる必要がある。
    const bg = `bgsrc${labelSuffix}`
    const fg = `fgsrc${labelSuffix}`
    const bgOut = `bgblur${labelSuffix}`
    const fgOut = `fgfit${labelSuffix}`
    return (
      `split=2[${bg}][${fg}];` +
      `[${bg}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
      `gblur=sigma=${blurSigmaFor(h)}${fpsPart}[${bgOut}];` +
      `[${fg}]scale=${w}:${h}:force_original_aspect_ratio=decrease${fpsPart}[${fgOut}];` +
      `[${bgOut}][${fgOut}]overlay=(W-w)/2:(H-h)/2`
    )
  }
  if (!fillCrop) {
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black${fpsPart}`
  }
  const cx = cropCenter?.x ?? 0.5
  const cy = cropCenter?.y ?? 0.5
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:'min(max(0,(iw*${cx}-ow/2)),(iw-ow))':'min(max(0,(ih*${cy}-oh/2)),(ih-oh))'${fpsPart}`
}

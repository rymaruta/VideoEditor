import type { FontFamily, TextAnimation, TextStyle } from './types'

/**
 * テロップの上下の余白(**枠の高さ**に対する比)。
 *
 * 書き出し(ASS の MarginV)とプレビュー(CSS の `top`/`bottom`)が**同じ数字**を使うための
 * 共通の置き場。書き写すと片方だけ育って黙ってズレる——実際、書き出しは上下とも 8% なのに
 * CSS だけ `.overlay-top { top: 8% }` / `.overlay-bottom { bottom: 10% }` と**下だけ 10%**に
 * なっていた。既定のテロップ位置が `bottom` なので、**既定のまま使うと必ず踏む**。
 * 実測(1280x720・既定スタイル): 画面では文字の下端が枠下から 10.59% なのに、
 * 書き出しでは 8.06% に焼かれていた(上と中央はズレていない)。
 *
 * `top`/`bottom` の `%` は親の**高さ**基準なので、高さ基準の書き出し側と単位は揃っている。
 * ズレていたのは基準ではなく数字そのものだった。
 */
export const TEXT_MARGIN_V_RATIO = 0.08

/** 枠の高さから上下の余白(px)を出す。書き出し側はこれを丸めて MarginV に入れる。 */
export function textMarginVPx(frameHeight: number): number {
  if (!Number.isFinite(frameHeight) || frameHeight <= 0) return 0
  return frameHeight * TEXT_MARGIN_V_RATIO
}

/**
 * テロップの左右の余白(**枠の幅**に対する比)。折り返す幅はこれで決まる。
 *
 * 画面は CSS の `left`/`right`、書き出しは ASS の MarginL/R と、**書く場所が違うだけで
 * 同じ規則**なので、数字はここ1つに置く(縦の余白と同じ理由)。
 */
export const TEXT_MARGIN_H_RATIO = 0.05

/** 枠の幅から左右の余白(px)を出す。書き出し側はこれを丸めて MarginL/R に入れる。 */
export function textMarginHPx(frameWidth: number): number {
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) return 0
  return frameWidth * TEXT_MARGIN_H_RATIO
}

/**
 * 登場アニメーション「下から出る」「上から出る」が動く距離(**枠の高さ**に対する比)。
 *
 * 書き出しは ASS の `\move`(キャンバス高の 6%)、画面は CSS の `@keyframes` と、
 * 上下左右の余白と同じく**書く場所が違うだけで同じ規則**なので、数字はここ1つに置く。
 * 画面側だけ `translateY(40px)` と**プレビュー枠のピクセルで固定**されていたため、
 * 枠の大きさが変わるたびに書き出しとの比が動き、既定のレイアウトでは
 * **2.8倍**遠くから飛び込んでいた。しかも `.preview-frame` は `overflow: hidden` なので、
 * 出だしはテロップが**枠の外に出て1画素も見えない**(実測: 枠 132.97x236.38 の 9:16 で
 * 移動距離が画面 40px = 枠高の **16.92%** に対し書き出しは **5.97%**。
 * 画面写真の枠の中の白い画素は開始時点で **0個**、書き出しは同じ時点で枠の中に収まっている)。
 */
export const TEXT_SLIDE_OFFSET_RATIO = 0.06

/**
 * 枠の高さから登場アニメーションの移動距離(px)を出す。単位は**渡した高さと同じ**
 * (書き出しなら ASS キャンバスのピクセル、画面ならプレビュー枠のピクセル)。
 * **画面側では整数に丸めないこと**——`translate` は小数pxを受け付けるので、
 * 丸めると縮小率が高いときに丸めのほうが誤差の主因になる(縁取りと同じ理由)。
 */
export function textSlideOffsetPx(frameHeight: number): number {
  if (!Number.isFinite(frameHeight) || frameHeight <= 0) return 0
  return frameHeight * TEXT_SLIDE_OFFSET_RATIO
}

/**
 * 登場アニメーションの長さ(ミリ秒)。
 *
 * 画面は CSS の `animation`、書き出しは ASS の `\move` / `\t` / `\fad` と**書く場所が
 * 違うだけで同じ規則**なので、数字はここ1つに置く(余白・飛び込む距離と同じ理由)。
 * `none` と `typewriter` は「1枚まるごとの登場」を持たない(後者は文字ごとに出る)ので 0。
 */
export const TEXT_ANIMATION_MS: Record<TextAnimation, number> = {
  none: 0,
  fadeIn: 300,
  popIn: 200,
  slideInUp: 350,
  slideInDown: 350,
  bounce: 500,
  typewriter: 0
}

/**
 * 登場時に**透明から不透明へ変わる**長さ(ミリ秒)。0 ならフェードしない。
 *
 * 画面の `@keyframes` は「下から出る」「上から出る」で `opacity: 0 → 1` を全体に、
 * 「弾む」では前半(50% = 250ms)で掛けている。書き出しには `\fad` が
 * **`fadeIn` にしか無かった**ので、同じ演出なのに画面だけふわっと出ていた。
 * (実測・下から出る: 開始時点の不透明度が画面 **0** / 87.5ms で **0.409** /
 *  175ms で **0.802** なのに、書き出しは同じ3点とも**完全に不透明**)
 * 拡大だけの `popIn` は画面側も透明度を触らないので 0。
 */
export const TEXT_FADE_IN_MS: Record<TextAnimation, number> = {
  none: 0,
  fadeIn: 300,
  popIn: 0,
  slideInUp: 350,
  slideInDown: 350,
  // 画面のキーフレームは 50%(=500ms の半分)で不透明になる
  bounce: 250,
  typewriter: 0
}

/**
 * 背景箱が文字からはみ出す量(**文字サイズに対する比**)。
 *
 * 画面は CSS の `padding`、書き出しは ASS の `\xbord`/`\ybord` と**書く場所が違うだけで
 * 同じ規則**なので、数字はここ1つに置く(上下左右の余白と同じ理由)。
 * 比で持つのが肝心——書き出し側は `\bord6` と**出力ピクセルの決め打ち**だったため、
 * 文字サイズを変えても箱の余白が変わらず、画面と食い違っていた。
 * 実測(1280 のキャンバス基準・左右): 文字サイズ 20/40/80 で画面は 8.0/16.0/32.0 なのに
 * 書き出しは **6/6/6** のまま。既定の 40 でも **2.67倍**の開きがあった。
 *
 * ASS の `\bord` は上下左右が同じ値になるが、`\xbord`/`\ybord` なら軸ごとに指定できる
 * (この libass で動くことを実測済み: `\xbord16\ybord6` で箱が 44x52 → 64x52px)。
 */
export const TEXT_BOX_PADDING_H_EM = 0.4
export const TEXT_BOX_PADDING_V_EM = 0.15

/**
 * 文字サイズから背景箱の余白を出す。単位は**渡した文字サイズと同じ**
 * (書き出しなら ASS キャンバスのピクセル)。
 * 文字サイズが数値でない・0以下なら余白なし(負の `\xbord` を書き出さない)。
 */
export function textBoxPaddingPx(fontSize: number): { x: number; y: number } {
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 0
  return { x: size * TEXT_BOX_PADDING_H_EM, y: size * TEXT_BOX_PADDING_V_EM }
}

export function defaultTextStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: 'sans-serif',
    fontSize: 40,
    color: '#ffffff',
    position: 'bottom',
    rotation: 0,
    bold: true,
    italic: false,
    outline: true,
    outlineColor: '#000000',
    outlineWidth: 3,
    shadow: false,
    background: false,
    backgroundColor: '#000000',
    backgroundOpacity: 0.5,
    letterSpacing: 0,
    animation: 'none',
    wordHighlight: false,
    highlightColor: '#ffe600',
    ...overrides
  }
}

export const FONT_FAMILY_OPTIONS: { value: FontFamily; label: string }[] = [
  { value: 'sans-serif', label: 'ゴシック体' },
  { value: 'serif', label: '明朝体' },
  { value: 'M PLUS Rounded 1c', label: '丸ゴシック' },
  { value: 'Noto Sans JP', label: 'Noto Sans JP' },
  { value: 'Noto Serif JP', label: 'Noto Serif JP' }
]

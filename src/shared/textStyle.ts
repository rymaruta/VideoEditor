import type { FontFamily, TextStyle } from './types'

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

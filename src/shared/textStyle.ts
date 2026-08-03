import type { FontFamily, TextStyle } from './types'

export function defaultTextStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: 'sans-serif',
    fontSize: 40,
    color: '#ffffff',
    position: 'bottom',
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

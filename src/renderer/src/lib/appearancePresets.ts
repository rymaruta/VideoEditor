import { normalizeGradient, normalizeTextStyle } from '@shared/textStyle'
import type { TelopGradient, TextStyle } from '@shared/types'

/**
 * 利用者が保存する見た目の部品。どの企画でも使えるよう、アプリの設定として持つ。
 *
 * - お気に入りのグラデーション(配色と向き)。文字の塗り・縁・背景・部分の装飾、どのグラデーション欄からでも使える
 * - 項目ごとの「マイ設定」(縁の組・影・光彩・背景・動きなど)。Photoshop のスタイル・CapCut のプリセットと同じく、
 *   ある項目の値だけを名前を付けて保存し、ほかのテロップに当てる
 */

export interface FavoriteGradient {
  id: string
  name: string
  gradient: TelopGradient
}

export interface SectionPreset {
  id: string
  name: string
  /** その項目に属する値だけ(当てると、その項目だけが置き換わる) */
  values: Partial<TextStyle>
}

export const MAX_FAVORITE_GRADIENTS = 32
export const MAX_SECTION_PRESETS = 40

/** 同じ配色(色・位置・向き・形)か */
export function sameGradient(a: TelopGradient, b: TelopGradient): boolean {
  return (
    (a.type ?? 'linear') === (b.type ?? 'linear') &&
    Math.round(a.angle) === Math.round(b.angle) &&
    a.stops.length === b.stops.length &&
    a.stops.every(
      (s, i) =>
        s.color.toLowerCase() === b.stops[i].color.toLowerCase() &&
        Math.abs(s.at - b.stops[i].at) < 0.005
    )
  )
}

/** お気に入りのグラデーションを足す(同じ配色があれば先頭へ寄せるだけ)。新しいものが先頭 */
export function addFavoriteGradient(
  list: readonly FavoriteGradient[],
  gradient: TelopGradient,
  name: string,
  id: string
): FavoriteGradient[] {
  const rest = list.filter((f) => !sameGradient(f.gradient, gradient))
  const existing = list.find((f) => sameGradient(f.gradient, gradient))
  const entry = existing ?? { id, name: name.trim() || `配色 ${list.length + 1}`, gradient }
  return [entry, ...rest].slice(0, MAX_FAVORITE_GRADIENTS)
}

/** 保存してあった値を読む(壊れた要素は捨てる) */
export function normalizeFavoriteGradients(raw: unknown): FavoriteGradient[] {
  if (!Array.isArray(raw)) return []
  const out: FavoriteGradient[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const gradient = normalizeGradient(o.gradient)
    if (!gradient || typeof o.id !== 'string') continue
    out.push({ id: o.id, name: typeof o.name === 'string' ? o.name : '配色', gradient })
  }
  return out.slice(0, MAX_FAVORITE_GRADIENTS)
}

/**
 * 項目ごとのマイ設定を読む。値は `normalizeTextStyle` を通して、その項目のキーだけを残す
 * (古い・壊れた値で書き出しが落ちないように)
 */
export function normalizeSectionPresets(
  raw: unknown,
  keysOf: (section: string) => readonly (keyof TextStyle)[] | undefined
): Record<string, SectionPreset[]> {
  const out: Record<string, SectionPreset[]> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [section, list] of Object.entries(raw as Record<string, unknown>)) {
    // 「toString」などの名前の項目(壊れた保存データ)で、ほかの項目まで捨てないように
    const keys = keysOf(section)
    if (!Array.isArray(keys) || !Array.isArray(list)) continue
    const presets: SectionPreset[] = []
    for (const r of list) {
      if (!r || typeof r !== 'object') continue
      const o = r as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.name !== 'string') continue
      presets.push({
        id: o.id,
        name: o.name,
        values: pickSection(normalizeTextStyle(o.values), keys)
      })
    }
    out[section] = presets.slice(0, MAX_SECTION_PRESETS)
  }
  return out
}

/** 見た目から、その項目のキーだけを抜き出す(無い値は undefined として持つ=当てると消える) */
export function pickSection(
  style: TextStyle,
  keys: readonly (keyof TextStyle)[]
): Partial<TextStyle> {
  const out: Partial<TextStyle> = {}
  for (const k of keys) (out as Record<string, unknown>)[k] = style[k]
  return out
}

/** 項目ごとの値の範囲(マイ設定に保存・当てるキー) */
export const SECTION_KEYS: Record<string, readonly (keyof TextStyle)[]> = {
  text: [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'bold',
    'italic',
    'vertical',
    'align',
    'arc',
    'letterSpacing',
    'lineHeight',
    'opacity'
  ],
  fill: ['color', 'fillGradient', 'gradientColor'],
  stroke: ['outline', 'outlineColor', 'outlineWidth', 'outlineGradient', 'extraStrokes'],
  background: [
    'background',
    'backgroundShape',
    'backgroundColor',
    'backgroundGradient',
    'backgroundOpacity',
    'backgroundRadius',
    'backgroundPadding',
    'backgroundSkew',
    'backgroundBorder',
    'bubbleTail'
  ],
  shadow: ['shadow', 'shadowColor', 'shadowOpacity', 'shadowAngle', 'shadowDistance', 'shadowBlur'],
  glow: ['glow'],
  spans: ['firstLine', 'accent', 'sub'],
  pointer: ['pointer'],
  motion: [
    'animation',
    'charAnimation',
    'exitAnimation',
    'loopAnimation',
    'animationSpeed',
    'wordHighlight',
    'highlightColor'
  ]
}

export const SECTION_LABEL: Record<string, string> = {
  text: 'テキスト',
  fill: '塗り',
  stroke: '縁',
  background: '背景',
  shadow: '影',
  glow: '光彩',
  spans: '部分の装飾',
  pointer: '矢印',
  motion: '動き'
}

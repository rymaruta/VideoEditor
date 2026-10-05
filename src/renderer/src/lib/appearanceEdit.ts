import { defaultTextStyle, TEXT_ANIMATION_MS, TEXT_FADE_IN_MS } from '@shared/textStyle'
import {
  CHAR_ANIMATION_MS,
  CHAR_STAGGER_MS,
  EXIT_ANIMATION_MS,
  stripTelopMarkup,
  telopSpeed,
  TYPEWRITER_CHAR_MS
} from '@shared/telop/render'
import type { TextOverlay, TextStyle } from '@shared/types'
import { pickSection, SECTION_KEYS } from './appearancePresets'
import { contrastRatio, relativeLuminance } from './colorValue'

/**
 * 見た目の欄の操作(項目ごとのマイ設定を当てる・既定に戻す・見た目のコピーと貼り付け・
 * 同じ見た目のテロップを探す・サムネイルに描く時刻)。画面から切り離した純粋な関数だけを置く。
 */

/** 項目の並び(見た目の欄の上から) */
export const SECTION_IDS = [
  'text',
  'fill',
  'stroke',
  'background',
  'shadow',
  'glow',
  'spans',
  'pointer',
  'motion'
] as const

export type SectionId = (typeof SECTION_IDS)[number]

/**
 * 保存した値を、その項目の **すべてのキー** を持つ差分に直す。
 * 値に無いキーは消す(undefined)。ただし必ず要るキー(太字・縁の有無など)は既定値で埋める
 * (保存は JSON なので、undefined のキーは保存の時点で落ちている)。
 */
export function sectionPatch(section: string, values: Partial<TextStyle>): Partial<TextStyle> {
  const keys = SECTION_KEYS[section] ?? []
  const base = defaultTextStyle() as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = (values as Record<string, unknown>)[k]
    out[k] = v !== undefined ? v : base[k]
  }
  return out as Partial<TextStyle>
}

/** その項目を既定(新しいテロップと同じ)に戻す差分 */
export function sectionDefaultPatch(section: string): Partial<TextStyle> {
  return pickSection(defaultTextStyle(), SECTION_KEYS[section] ?? [])
}

/** 比べるための形(undefined のキーは無いものと同じに扱う) */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>)
            .filter(([, y]) => y !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        )
      : x
  )
}

/** 見た目の、その項目の値が `values` と同じか */
export function sectionMatches(
  style: TextStyle,
  section: string,
  values: Partial<TextStyle>
): boolean {
  const keys = SECTION_KEYS[section] ?? []
  return canonical(pickSection(style, keys)) === canonical(sectionPatch(section, values))
}

/** その項目が既定のままか(「既定に戻す」を出すかどうか) */
export function isSectionDefault(style: TextStyle, section: string): boolean {
  return sectionMatches(style, section, sectionDefaultPatch(section))
}

/** 選んだ項目の値をまとめて抜き出す(見た目のコピー → 貼り付け) */
export function lookPatch(style: TextStyle, sections: readonly string[]): Partial<TextStyle> {
  const out: Partial<TextStyle> = {}
  for (const s of sections) Object.assign(out, pickSection(style, SECTION_KEYS[s] ?? []))
  return out
}

/** 見た目(置き場所・回転を除く全項目)の指紋。同じ見た目のテロップを探すのに使う */
export function lookKey(style: TextStyle): string {
  return canonical(lookPatch(style, SECTION_IDS))
}

export interface TargetGroup {
  id: 'this' | 'same-look' | 'same-speaker' | 'same-style' | 'speech' | 'all'
  label: string
  /** 当てるテロップ(選んでいる1本も含む) */
  ids: string[]
}

/**
 * 見た目をまとめて当てる先の候補(CapCut の「すべてに適用」、Premiere の「属性をペースト」)。
 * 1本しか無い組は出さない(選んでいるテロップだけなら「このテロップに」で足りる)。
 */
export function telopTargetGroups(
  overlays: readonly Pick<TextOverlay, 'id' | 'style' | 'speaker' | 'styleId' | 'utteranceId'>[],
  current: Pick<TextOverlay, 'id' | 'style' | 'speaker' | 'styleId' | 'utteranceId'>
): TargetGroup[] {
  const groups: TargetGroup[] = []
  const add = (id: TargetGroup['id'], label: string, ids: string[]): void => {
    if (ids.length > 1) groups.push({ id, label, ids })
  }
  const key = lookKey(current.style)
  add(
    'same-look',
    '今と同じ見た目のテロップ',
    overlays.filter((o) => o.id === current.id || lookKey(o.style) === key).map((o) => o.id)
  )
  const speaker = current.speaker?.trim()
  if (speaker)
    add(
      'same-speaker',
      `話者「${speaker}」のテロップ`,
      overlays.filter((o) => o.speaker?.trim() === speaker).map((o) => o.id)
    )
  if (current.styleId)
    add(
      'same-style',
      '同じスタイルのテロップ',
      overlays.filter((o) => o.styleId === current.styleId).map((o) => o.id)
    )
  if (current.utteranceId)
    add(
      'speech',
      '発言テロップすべて',
      overlays.filter((o) => o.utteranceId).map((o) => o.id)
    )
  add(
    'all',
    'すべてのテロップ',
    overlays.map((o) => o.id)
  )
  return groups
}

/** 文字の塗りの代表の色(グラデーションなら明るさの平均に近い端) */
function fillColorOf(style: TextStyle): string {
  const g = style.fillGradient
  if (g && g.stops.length > 0) return g.stops[Math.floor(g.stops.length / 2)].color
  return style.color
}

/**
 * 背景を付けたときの、文字が読める色。今の背景の色で文字が読める(コントラスト比 3 以上)なら
 * そのまま、読めなければ文字の明るさの反対(白文字なら黒、暗い文字なら白)にする。
 * 薄すぎる背景も読めないので、不透明度は 0.35 未満なら 0.6 に上げる。
 */
export function readableBackground(
  style: TextStyle
): Pick<TextStyle, 'backgroundColor' | 'backgroundOpacity'> {
  const fill = fillColorOf(style)
  const color =
    style.backgroundGradient || contrastRatio(fill, style.backgroundColor) >= 3
      ? style.backgroundColor
      : relativeLuminance(fill) > 0.35
        ? '#000000'
        : '#ffffff'
  return {
    backgroundColor: color,
    backgroundOpacity: style.backgroundOpacity < 0.35 ? 0.6 : style.backgroundOpacity
  }
}

/**
 * 止め絵(サムネイル・見本)に描く時刻。登場の動きが終わってから、消える動きが始まる前。
 * `drawTelop` に `{ startTime: 0, endTime }` で渡し、`time` で描く。
 */
export function settledTelopTime(
  style: TextStyle,
  text: string
): { time: number; endTime: number } {
  const speed = telopSpeed(style)
  const chars = Array.from(stripTelopMarkup(text)).length
  const entranceMs = Math.max(
    TEXT_ANIMATION_MS[style.animation] ?? 0,
    TEXT_FADE_IN_MS[style.animation] ?? 0,
    style.animation === 'typewriter' ? (chars + 1) * TYPEWRITER_CHAR_MS : 0,
    style.charAnimation && style.charAnimation !== 'none'
      ? CHAR_ANIMATION_MS + chars * CHAR_STAGGER_MS
      : 0
  )
  const time = entranceMs / speed / 1000 + 0.05
  return { time, endTime: time + EXIT_ANIMATION_MS / speed / 1000 + 1 }
}

/** 止め絵用の見た目(出ている間ずっと続く動きは、止め絵では途中の姿になるので外す) */
export function stillTelopStyle(style: TextStyle): TextStyle {
  return { ...style, loopAnimation: undefined }
}

/**
 * 吹き出し(色・マイ設定など)を、基準の欄の近くで画面からはみ出さない位置に置く。
 * 下に入らなければ上へ、右に入らなければ右端を揃え、それでも入らなければ画面の中へ押し込む。
 * 画面より大きいときは上・左に揃える(呼び出し側で max-height とスクロールを付ける)。
 */
export function placePopover(
  anchor: { top: number; bottom: number; left: number; right: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
  margin = 8
): { top: number; left: number } {
  let top = anchor.bottom + gap
  if (top + size.height > viewport.height - margin && anchor.top - gap - size.height >= margin)
    top = anchor.top - gap - size.height
  let left = anchor.left
  if (left + size.width > viewport.width - margin) left = anchor.right - size.width
  top = Math.max(margin, Math.min(top, viewport.height - margin - size.height))
  left = Math.max(margin, Math.min(left, viewport.width - margin - size.width))
  return { top: Math.round(top), left: Math.round(left) }
}

/** ドラッグした量(px)から値を決める(2px で1目盛り。範囲に収め、目盛りの桁に丸める) */
export function scrubValue(
  start: number,
  dx: number,
  step: number,
  factor: number,
  min: number,
  max: number
): number {
  const raw = start + Math.round(dx / 2) * step * factor
  const decimals = Math.min(4, (String(step * factor).split('.')[1] ?? '').length)
  const v = Number(Math.min(max, Math.max(min, raw)).toFixed(decimals))
  return Object.is(v, -0) ? 0 : v
}

/** 書体の一覧を、名前・分類で絞り込む(全角半角・大文字小文字は区別しない) */
export function filterFonts(
  options: readonly { value: string; label: string; group: string }[],
  query: string
): { value: string; label: string; group: string }[] {
  const q = query.normalize('NFKC').trim().toLowerCase()
  if (!q) return [...options]
  return options.filter((o) =>
    `${o.label} ${o.value} ${o.group}`.normalize('NFKC').toLowerCase().includes(q)
  )
}

/** 検索に合うか(空白で区切った言葉がすべて含まれる。大文字小文字・全角半角は区別しない) */
export function matchesLookQuery(
  item: { name: string; text: string; group: string; keywords?: string },
  query: string
): boolean {
  const words = query.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = `${item.name} ${item.text} ${item.group} ${item.keywords ?? ''}`
    .normalize('NFKC')
    .toLowerCase()
  return words.every((w) => hay.includes(w))
}

/**
 * 見た目を、文字の大きさごと拡大・縮小する(縁の太さ・余白・影の距離なども同じ割合で)。
 * テロップ用の見た目をサムネイルの大きな文字に当てるときに使う(縁だけ細く見えないように)。
 */
export function scaleLook(style: TextStyle, factor: number): TextStyle {
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return style
  const k = (v: number | undefined): number | undefined =>
    v === undefined ? undefined : Math.round(v * factor * 100) / 100
  return {
    ...style,
    fontSize: Math.max(1, Math.round(style.fontSize * factor)),
    outlineWidth: k(style.outlineWidth) ?? style.outlineWidth,
    letterSpacing: k(style.letterSpacing) ?? style.letterSpacing,
    extraStrokes: style.extraStrokes?.map((s) => ({ ...s, width: k(s.width) ?? s.width })),
    shadowDistance: k(style.shadowDistance),
    shadowBlur: k(style.shadowBlur),
    glow: style.glow ? { ...style.glow, size: k(style.glow.size) ?? style.glow.size } : undefined,
    backgroundRadius: k(style.backgroundRadius),
    backgroundPadding: style.backgroundPadding
      ? { x: k(style.backgroundPadding.x) ?? 0, y: k(style.backgroundPadding.y) ?? 0 }
      : undefined,
    backgroundBorder: style.backgroundBorder
      ? { ...style.backgroundBorder, width: k(style.backgroundBorder.width) ?? 0 }
      : undefined,
    bubbleTail: style.bubbleTail
      ? { ...style.bubbleTail, length: k(style.bubbleTail.length) ?? 0 }
      : undefined,
    pointer: style.pointer
      ? { ...style.pointer, width: k(style.pointer.width) ?? style.pointer.width }
      : undefined
  }
}

import type { TelopGradient, TelopStroke, TextStyle } from '@shared/types'
import { TEXT_SHADOW_OFFSET_PX, TEXT_SHADOW_OPACITY } from '@shared/textStyle'
import { normalizeHex, parseColor, rgbToHex, type Rgb } from './colorValue'

/**
 * テロップの見た目の欄(塗り・縁・背景・影…)で使う、画面に依存しない計算。
 * グラデーションの色の止まりの足し引き・並べ替えと、縁の一覧 ↔ `TextStyle` の読み書きを置く。
 */

/** グラデーションの色の数(描画側の `normalizeGradient` と同じ上限・下限) */
export const GRADIENT_MAX_STOPS = 8
export const GRADIENT_MIN_STOPS = 2

/** 縁は何本まで重ねられるか(内側の縁 + 外側の縁) */
export const MAX_STROKES = 6

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** 色の止まりを位置の順に並べ直す(元の配列は変えない) */
export function sortGradientStops(g: TelopGradient): TelopGradient {
  return { ...g, stops: [...g.stops].sort((a, b) => a.at - b.at) }
}

/** `at`(0〜1)の所の色。止まりと止まりの間は RGB で直線に混ぜる */
export function gradientColorAt(g: TelopGradient, at: number): string {
  const stops = sortGradientStops(g).stops
  if (stops.length === 0) return '#ffffff'
  const t = clamp01(at)
  if (t <= stops[0].at) return normalizeHex(stops[0].color) ?? stops[0].color
  const last = stops[stops.length - 1]
  if (t >= last.at) return normalizeHex(last.color) ?? last.color
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]
    const b = stops[i]
    if (t > b.at) continue
    const ca = parseColor(a.color)
    const cb = parseColor(b.color)
    if (!ca || !cb) return a.color
    const k = b.at - a.at > 1e-9 ? (t - a.at) / (b.at - a.at) : 0
    return rgbToHex({
      r: ca.r + (cb.r - ca.r) * k,
      g: ca.g + (cb.g - ca.g) * k,
      b: ca.b + (cb.b - ca.b) * k
    })
  }
  return last.color
}

/**
 * 色の止まりを `at` の所に足す(色はその位置の今の色)。上限なら何もしない。
 * 足した止まりの並び順での番号も返す(足した直後にその止まりを選んでおくため)。
 */
export function addGradientStop(
  g: TelopGradient,
  at: number
): { gradient: TelopGradient; index: number } {
  const sorted = sortGradientStops(g)
  if (sorted.stops.length >= GRADIENT_MAX_STOPS) return { gradient: sorted, index: -1 }
  const t = clamp01(at)
  const stop = { at: t, color: gradientColorAt(sorted, t) }
  const stops = [...sorted.stops, stop].sort((a, b) => a.at - b.at)
  return { gradient: { ...sorted, stops }, index: stops.indexOf(stop) }
}

/** 色の止まりを消す。下限(2色)なら何もしない */
export function removeGradientStop(g: TelopGradient, index: number): TelopGradient {
  if (g.stops.length <= GRADIENT_MIN_STOPS || index < 0 || index >= g.stops.length) return g
  return { ...g, stops: g.stops.filter((_, i) => i !== index) }
}

/**
 * 色の止まりを `at` へ動かす。並び順が入れ替わるので、動かした止まりの新しい番号も返す
 * (引きずっている間、同じ止まりを持ち続けるため)
 */
export function moveGradientStop(
  g: TelopGradient,
  index: number,
  at: number
): { gradient: TelopGradient; index: number } {
  if (index < 0 || index >= g.stops.length) return { gradient: g, index }
  const moved = { ...g.stops[index], at: clamp01(at) }
  const stops = g.stops.map((s, i) => (i === index ? moved : s)).sort((a, b) => a.at - b.at)
  return { gradient: { ...g, stops }, index: stops.indexOf(moved) }
}

/** 止まりの色を変える */
export function recolorGradientStop(g: TelopGradient, index: number, color: string): TelopGradient {
  return { ...g, stops: g.stops.map((s, i) => (i === index ? { ...s, color } : s)) }
}

/** 角度を 0〜359 に揃える */
export function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0
  return ((Math.round(angle) % 360) + 360) % 360
}

/**
 * グラデーションを CSS の `linear-gradient` にする。描画側は 0 が上→下・90 が左→右、
 * CSS は 180deg が上→下・90deg が左→右なので `180 - angle`。
 */
export function gradientCss(g: TelopGradient): string {
  const stops = sortGradientStops(g)
    .stops.map((s) => `${s.color} ${Math.round(clamp01(s.at) * 1000) / 10}%`)
    .join(', ')
  if (g.type === 'radial') return `radial-gradient(circle, ${stops})`
  return `linear-gradient(${normalizeAngle(180 - g.angle)}deg, ${stops})`
}

/** 色の並びを逆にする(上が濃い ↔ 下が濃い) */
export function reverseGradient(g: TelopGradient): TelopGradient {
  return sortGradientStops({
    ...g,
    stops: g.stops.map((s) => ({ ...s, at: Math.round((1 - s.at) * 1000) / 1000 }))
  })
}

/** 色の止まりを等間隔に並べ直す */
export function distributeGradient(g: TelopGradient): TelopGradient {
  const sorted = sortGradientStops(g).stops
  const n = sorted.length
  return {
    ...g,
    stops: sorted.map((s, i) => ({ ...s, at: n > 1 ? Math.round((i / (n - 1)) * 1000) / 1000 : 0 }))
  }
}

/** RGB(0〜255)↔ HSL(色相 0〜360・彩度/明度 0〜1) */
function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === R) h = ((G - B) / d) % 6
  else if (max === G) h = (B - R) / d + 2
  else h = (R - G) / d + 4
  return { h: (h * 60 + 360) % 360, s, l }
}
function hslToHex(h: number, s: number, l: number): string {
  const S = Math.min(1, Math.max(0, s))
  const L = Math.min(1, Math.max(0, l))
  const c = (1 - Math.abs(2 * L - 1)) * S
  const hh = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const [r1, g1, b1] =
    hh < 1
      ? [c, x, 0]
      : hh < 2
        ? [x, c, 0]
        : hh < 3
          ? [0, c, x]
          : hh < 4
            ? [0, x, c]
            : hh < 5
              ? [x, 0, c]
              : [c, 0, x]
  const m = L - c / 2
  return rgbToHex({
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255)
  })
}

/**
 * 1つの色から作る配色の提案(デザインツールの「配色のルール」と同じ考え方)。
 * 文字の色を決めたあと「この色に合うグラデーション」を1回で選べるようにする
 */
export function gradientSuggestions(
  color: string,
  angle = 0
): { name: string; gradient: TelopGradient }[] {
  const rgb = parseColor(color)
  if (!rgb) return []
  const { h, s, l } = rgbToHsl(rgb)
  // 無彩色(白・黒・灰)は彩度を足さない
  const sat = s < 0.08 ? 0 : Math.max(0.55, s)
  const g = (name: string, colors: string[]): { name: string; gradient: TelopGradient } => ({
    name,
    gradient: {
      angle,
      stops: colors.map((c, i) => ({
        at: colors.length > 1 ? i / (colors.length - 1) : 0,
        color: c
      }))
    }
  })
  return [
    g('明→暗', [
      hslToHex(h, sat, Math.min(0.9, l + 0.3)),
      hslToHex(h, sat, Math.max(0.15, l - 0.2))
    ]),
    g('光沢', [
      hslToHex(h, sat * 0.6, 0.95),
      hslToHex(h, sat, Math.max(0.3, l)),
      hslToHex(h, sat, Math.max(0.15, l - 0.25))
    ]),
    g('類似色', [hslToHex(h - 30, sat, l), hslToHex(h + 30, sat, l)]),
    g('補色', [hslToHex(h, sat, l), hslToHex(h + 180, sat, l)]),
    g('3色', [hslToHex(h, sat, l), hslToHex(h + 120, sat, l), hslToHex(h + 240, sat, l)]),
    g('白から', ['#ffffff', hslToHex(h, sat, l)])
  ]
}

/** 止まりを横一列に並べた見本(向きは無視して左→右) */
export function gradientBarCss(g: TelopGradient): string {
  return gradientCss({ ...g, angle: 90 })
}

/** すぐ選べるグラデーション(よく見るバラエティ・ゲーム実況の色) */
export const GRADIENT_PRESETS: { name: string; gradient: TelopGradient }[] = [
  {
    name: '金',
    gradient: {
      angle: 0,
      stops: [
        { at: 0, color: '#fff6c8' },
        { at: 0.45, color: '#ffd54a' },
        { at: 0.55, color: '#d99a00' },
        { at: 1, color: '#fff0a0' }
      ]
    }
  },
  {
    name: '銀',
    gradient: {
      angle: 0,
      stops: [
        { at: 0, color: '#ffffff' },
        { at: 0.5, color: '#b8c0c8' },
        { at: 0.52, color: '#8a939c' },
        { at: 1, color: '#eef2f5' }
      ]
    }
  },
  {
    name: '炎',
    gradient: {
      angle: 0,
      stops: [
        { at: 0, color: '#fff35c' },
        { at: 0.5, color: '#ff8a00' },
        { at: 1, color: '#e0161b' }
      ]
    }
  },
  {
    name: '海',
    gradient: {
      angle: 0,
      stops: [
        { at: 0, color: '#c9f6ff' },
        { at: 0.5, color: '#38b6ff' },
        { at: 1, color: '#0a3fa8' }
      ]
    }
  },
  {
    name: '虹',
    gradient: {
      angle: 90,
      stops: [
        { at: 0, color: '#ff3b3b' },
        { at: 0.2, color: '#ff9f1a' },
        { at: 0.4, color: '#ffe600' },
        { at: 0.6, color: '#3ddc5a' },
        { at: 0.8, color: '#2f8cff' },
        { at: 1, color: '#a24bff' }
      ]
    }
  },
  {
    name: '夕焼け',
    gradient: {
      angle: 0,
      stops: [
        { at: 0, color: '#ffd166' },
        { at: 0.5, color: '#ff6f61' },
        { at: 1, color: '#8e3fbf' }
      ]
    }
  },
  {
    name: '桜',
    gradient: {
      angle: 0,
      stops: [
        { at: 0, color: '#ffffff' },
        { at: 1, color: '#ff8fc0' }
      ]
    }
  },
  {
    name: 'ネオン',
    gradient: {
      angle: 90,
      stops: [
        { at: 0, color: '#00f0ff' },
        { at: 1, color: '#ff2bd6' }
      ]
    }
  }
]

/** 単色からグラデーションに切り替えたときの最初の形(今の色 → 少し暗い色、上→下) */
export function gradientFromColor(color: string): TelopGradient {
  const c = parseColor(color) ?? { r: 255, g: 255, b: 255 }
  const hex = rgbToHex(c)
  // 明るい色は暗く、暗い色は明るくして、違いが見えるようにする
  const lum = (c.r * 299 + c.g * 587 + c.b * 114) / 1000
  const k = lum > 128 ? 0.55 : 1.8
  const other = rgbToHex({
    r: Math.min(255, c.r * k + (k > 1 ? 40 : 0)),
    g: Math.min(255, c.g * k + (k > 1 ? 40 : 0)),
    b: Math.min(255, c.b * k + (k > 1 ? 40 : 0))
  })
  return {
    angle: 0,
    stops: [
      { at: 0, color: hex },
      { at: 1, color: other }
    ]
  }
}

/** グラデーションをやめて単色に戻すときの色(真ん中の色) */
export function colorFromGradient(g: TelopGradient): string {
  return gradientColorAt(g, 0.5)
}

/** 文字の塗りに実際に使われるグラデーション(旧形式の `gradientColor` も読む) */
export function effectiveFillGradient(
  style: Pick<TextStyle, 'fillGradient' | 'gradientColor' | 'color'>
): TelopGradient | undefined {
  if (style.fillGradient) return style.fillGradient
  if (!style.gradientColor) return undefined
  return {
    angle: 0,
    stops: [
      { at: 0, color: style.color },
      { at: 1, color: style.gradientColor }
    ]
  }
}

// ------------------------------------------------------------------ 縁の一覧

/**
 * 縁の一覧(**内側から順**)。1本目は `outline*`(従来の縁)、2本目以降は `extraStrokes`。
 * 描画(`telopStrokeRings`)もこの順で内側から外へ積む。
 */
export function strokesFromStyle(
  style: Pick<
    TextStyle,
    'outline' | 'outlineColor' | 'outlineWidth' | 'outlineGradient' | 'extraStrokes'
  >
): TelopStroke[] {
  const out: TelopStroke[] = []
  if (style.outline && style.outlineWidth > 0) {
    out.push({
      color: style.outlineColor,
      width: style.outlineWidth,
      ...(style.outlineGradient ? { gradient: style.outlineGradient } : {})
    })
  }
  for (const s of style.extraStrokes ?? []) if (s.width > 0) out.push({ ...s })
  return out
}

/**
 * 縁の一覧を `TextStyle` の差分にする。空なら縁なし(色・太さは残して、また付けたときに戻る)。
 * 1本目 → `outline*`、残り → `extraStrokes`。
 */
export function strokesToStyle(list: readonly TelopStroke[]): Partial<TextStyle> {
  if (list.length === 0) {
    return { outline: false, outlineGradient: undefined, extraStrokes: undefined }
  }
  const [first, ...rest] = list
  return {
    outline: true,
    outlineColor: first.color,
    outlineWidth: Math.max(0.5, first.width),
    outlineGradient: first.gradient,
    extraStrokes:
      rest.length > 0 ? rest.map((s) => ({ ...s, width: Math.max(0.5, s.width) })) : undefined
  }
}

/** 縁を外側に1本足す(内側が黒なら白、それ以外は黒。太さは1本目より少し太く) */
export function addStroke(list: readonly TelopStroke[]): TelopStroke[] {
  if (list.length >= MAX_STROKES) return [...list]
  const last = list.at(-1)
  if (!last) return [{ color: '#000000', width: 3 }]
  const dark = (parseColor(last.color) ?? { r: 0, g: 0, b: 0 }).r < 128
  return [
    ...list,
    { color: dark ? '#ffffff' : '#000000', width: Math.max(3, Math.round(last.width)) }
  ]
}

/** `index` の縁を `delta`(-1 で内側へ / +1 で外側へ)だけ動かす */
export function moveStroke(
  list: readonly TelopStroke[],
  index: number,
  delta: number
): TelopStroke[] {
  const to = index + delta
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item)
  return next
}

// ------------------------------------------------------------------ 影・矢印

/** 影の向き・距離の表示用の値。未指定なら従来の右下 (2, 2) と同じ見た目になる値 */
export function shadowDisplay(
  style: Pick<
    TextStyle,
    'shadowAngle' | 'shadowDistance' | 'shadowOpacity' | 'shadowColor' | 'shadowBlur'
  >
): { angle: number; distance: number; opacity: number; color: string; blur: number } {
  return {
    angle: style.shadowAngle ?? 45,
    distance: style.shadowDistance ?? Math.round(TEXT_SHADOW_OFFSET_PX * Math.SQRT2 * 100) / 100,
    opacity: style.shadowOpacity ?? TEXT_SHADOW_OPACITY,
    color: style.shadowColor ?? '#000000',
    blur: style.shadowBlur ?? 0
  }
}

/** 矢印の向きのボタン(8方向)。長さは今の長さを保つ */
export function pointerToward(
  current: { dx: number; dy: number },
  dirX: number,
  dirY: number
): { dx: number; dy: number } {
  const len = Math.max(0.05, Math.hypot(current.dx, current.dy))
  const n = Math.hypot(dirX, dirY) || 1
  const r = (v: number): number => Math.round(v * 1000) / 1000
  return { dx: r((dirX / n) * len), dy: r((dirY / n) * len) }
}

/** 文字の太さの選択肢 */
export const FONT_WEIGHT_OPTIONS: { value: number; label: string }[] = [
  { value: 100, label: '100 極細' },
  { value: 200, label: '200 細' },
  { value: 300, label: '300 やや細' },
  { value: 400, label: '400 標準' },
  { value: 500, label: '500 中' },
  { value: 600, label: '600 やや太' },
  { value: 700, label: '700 太' },
  { value: 800, label: '800 極太' },
  { value: 900, label: '900 超極太' }
]

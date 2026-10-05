/**
 * 色の値(テロップの文字・縁・帯などの色)。保存の形は `#rrggbb`(小文字)。
 * 手で打った値は、よくある書き方(`#abc`・`abc`・`rgb(1, 2, 3)`・`1,2,3`)も受け付ける。
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => clampByte(v).toString(16).padStart(2, '0')).join('')}`
}

/** 読めなければ null */
export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase()
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)
  if (hex) {
    const h =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map((c) => c + c)
            .join('')
        : hex[1]
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    }
  }
  const nums = /^(?:rgb\s*\()?\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)?$/.exec(s)
  if (nums) {
    const [r, g, b] = nums.slice(1, 4).map(Number)
    if ([r, g, b].every((v) => v <= 255)) return { r, g, b }
  }
  return null
}

/** `#rrggbb` に揃える(読めなければ null) */
export function normalizeHex(input: string): string | null {
  const rgb = parseColor(input)
  return rgb ? rgbToHex(rgb) : null
}

/** お気に入りの色の上限 */
export const MAX_FAVORITE_COLORS = 24

/** お気に入りに足す(重複は前へ移す。上限を超えたら古いものから落とす) */
export function addFavoriteColor(list: readonly string[], color: string): string[] {
  const hex = normalizeHex(color)
  if (!hex) return [...list]
  return [hex, ...list.filter((c) => c !== hex)].slice(0, MAX_FAVORITE_COLORS)
}

/** 保存していた一覧を読み直す(壊れた値は捨てる) */
export function normalizeFavoriteColors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    const hex = typeof v === 'string' ? normalizeHex(v) : null
    if (hex && !out.includes(hex)) out.push(hex)
  }
  return out.slice(0, MAX_FAVORITE_COLORS)
}

/** 最近使った色の数(お気に入りとは別に、選んだ色を自動で覚えておく) */
export const MAX_RECENT_COLORS = 12

/** 最近使った色に足す(新しいものが先頭。重複は前へ移す) */
export function pushRecentColor(list: readonly string[], color: string): string[] {
  const hex = normalizeHex(color)
  if (!hex) return [...list]
  return [hex, ...list.filter((c) => c !== hex)].slice(0, MAX_RECENT_COLORS)
}

/** 保存していた「最近使った色」を読み直す */
export function normalizeRecentColors(raw: unknown): string[] {
  return normalizeFavoriteColors(raw).slice(0, MAX_RECENT_COLORS)
}

/** 相対輝度(0 黒 〜 1 白。WCAG の式) */
export function relativeLuminance(color: string): number {
  const rgb = parseColor(color)
  if (!rgb) return 1
  const lin = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b)
}

/** 2色のコントラスト比(1〜21) */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

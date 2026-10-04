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

/**
 * 上段左のパネルのタブの並べ方。10 個を超えるタブを横に並べると、1366 幅では横に送らないと
 * 見つからなかった。よく使うものだけを表に出し、残りは「その他」の中に用途ごとにまとめる。
 * 選んだタブは覚えて、次に開いたときもそのタブにする。
 */

/** 表に出すタブ(よく使うもの。並びもこの順) */
export const PRIMARY_PANEL_TABS = ['inspector', 'text', 'audio', 'template'] as const

/** 「その他」の中のまとまり(用途ごと)。ここに無いタブは「その他」の最後のまとまりに入れる */
export const PANEL_TAB_GROUPS: readonly { label: string; ids: readonly string[] }[] = [
  { label: '素材づくり', ids: ['narration', 'thumbnail'] },
  { label: '仕上げ', ids: ['preset'] },
  { label: '投稿', ids: ['metadata', 'youtube', 'gametrend'] }
]

export interface PanelTabDef {
  id: string
  label: string
}

/** 表のタブと「その他」のまとまりに分ける(定義に無い id は捨て、どこにも無いタブは最後のまとまりへ) */
export function splitPanelTabs<T extends PanelTabDef>(
  defs: readonly T[]
): { primary: T[]; groups: { label: string; tabs: T[] }[] } {
  const byId = new Map(defs.map((d) => [d.id, d]))
  const primary = PRIMARY_PANEL_TABS.map((id) => byId.get(id)).filter((d): d is T => Boolean(d))
  const used = new Set<string>(primary.map((d) => d.id))
  const groups = PANEL_TAB_GROUPS.map((g) => ({
    label: g.label,
    tabs: g.ids
      .map((id) => byId.get(id))
      .filter((d): d is T => {
        if (!d || used.has(d.id)) return false
        used.add(d.id)
        return true
      })
  }))
  const rest = defs.filter((d) => !used.has(d.id))
  if (rest.length > 0) {
    if (groups.length > 0) groups[groups.length - 1].tabs.push(...rest)
    else groups.push({ label: 'その他', tabs: [...rest] })
  }
  return { primary, groups: groups.filter((g) => g.tabs.length > 0) }
}

/** そのタブが「その他」の中にあるか */
export function isInMore(id: string, defs: readonly PanelTabDef[]): boolean {
  return defs.some((d) => d.id === id) && !(PRIMARY_PANEL_TABS as readonly string[]).includes(id)
}

/** 覚えておいたタブ(無い・知らないタブなら既定) */
export function storedPanelTab(
  raw: string | null | undefined,
  defs: readonly PanelTabDef[],
  fallback: string
): string {
  return raw && defs.some((d) => d.id === raw) ? raw : fallback
}

/**
 * 「その他」のメニューの中の矢印キーの移り先(上下で巡回、Home/End で端)。動かないキーなら null
 */
export function moveMenuFocus(key: string, index: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return (index + 1 + count) % count
    case 'ArrowUp':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

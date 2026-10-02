import type { TextOverlay, TextStyle } from '../types'

/**
 * テロップスタイル(名前の付いた見た目)と、それを使うテロップのつながり。
 *
 * テロップは `styleId` でスタイルを指す。スタイルを直すと、指しているテロップ全部の見た目が
 * 変わる(Premiere のマスタースタイルと同じ考え方)。テロップは見た目の値そのものも持ち続けるので、
 * スタイルが消えても書き出しは変わらない。
 *
 * 手で動かした置き場所(自由配置)はテロップごとのものなので、スタイルを当て直しても残す。
 */

export interface TelopStyleDef {
  id: string
  name: string
  style: TextStyle
  /** この話者の発言テロップに自動で使う */
  speakers?: string[]
}

/** スタイルの見た目を、テロップの置き場所を残したまま当てる */
export function applyLook(overlayStyle: TextStyle, look: TextStyle): TextStyle {
  return { ...look, customPosition: overlayStyle.customPosition }
}

/** その話者に自動で使うスタイル(最初に見つかったもの)。無ければ null */
export function styleForSpeaker(
  styles: readonly TelopStyleDef[],
  speaker: string | undefined
): TelopStyleDef | null {
  const name = speaker?.trim()
  if (!name) return null
  return styles.find((s) => s.speakers?.some((sp) => sp.trim() === name)) ?? null
}

/** スタイルごとの使用本数 */
export function countStyleUsage(
  overlays: readonly Pick<TextOverlay, 'styleId'>[]
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const o of overlays) {
    if (o.styleId) counts.set(o.styleId, (counts.get(o.styleId) ?? 0) + 1)
  }
  return counts
}

/**
 * スタイルの一覧を新しくしたときに、テロップへ反映する。
 *
 * - 指しているスタイルがあれば、その見た目に揃える
 * - 指しているスタイルが消えていれば、つながりだけ外す(見た目はそのまま)
 * - どのスタイルも指していない発言テロップは、話者に割り当てたスタイルがあればそれを使う
 *   (手で個別に整えたものを勝手に上書きしないよう、スタイル付きのものは話者で付け替えない)
 *
 * 変わらなかったテロップは同じオブジェクトのまま返す(描き直しを最小にするため)。
 */
export function restyleOverlays(
  overlays: readonly TextOverlay[],
  styles: readonly TelopStyleDef[]
): TextOverlay[] {
  const byId = new Map(styles.map((s) => [s.id, s]))
  return overlays.map((o) => {
    if (o.styleId) {
      const def = byId.get(o.styleId)
      if (!def) return { ...o, styleId: undefined }
      const style = applyLook(o.style, def.style)
      return JSON.stringify(style) === JSON.stringify(o.style) ? o : { ...o, style }
    }
    const auto = styleForSpeaker(styles, o.speaker)
    if (!auto) return o
    return { ...o, styleId: auto.id, style: applyLook(o.style, auto.style) }
  })
}

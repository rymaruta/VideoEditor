import type { TextOverlay, TextStyle } from '../types'
import { TELOP_TEMPLATES } from './templates'

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

/**
 * スタイルの見た目を、テロップの置き場所を残したまま当てる。
 *
 * 置き場所の決まり: 自由配置(`customPosition`)はいつもテロップのもの。
 * `keepPlacement` では上・下・中央の別と傾きも残す——スタイルを直した・話者に割り当てた・発言テロップの
 * 見た目を選び直した、のように**そのテロップを選ばずに**見た目が伝わるときに使う(顔を避けて上へ移した
 * 発言テロップを下へ戻さない、手で傾けたテロップをまっすぐに戻さない)。
 * 人がそのテロップに見た目を選んだときは、見た目の上・下・中央に従う
 */
export function applyLook(
  overlayStyle: TextStyle,
  look: TextStyle,
  options: { keepPlacement?: boolean } = {}
): TextStyle {
  return {
    ...look,
    ...(options.keepPlacement
      ? { position: overlayStyle.position, rotation: overlayStyle.rotation }
      : {}),
    customPosition: overlayStyle.customPosition
  }
}

/** 自動で入れた発言テロップ(置き場所は顔・HUD・重なりを避けて自動で決めたもの) */
const isAutoSpeech = (o: Pick<TextOverlay, 'source' | 'utteranceId'>): boolean =>
  o.source === 'auto' && o.utteranceId !== undefined

/** 自動で入れる発言テロップの見た目の既定(テロップの型の「発言(白・黒縁)」) */
export const DEFAULT_SPEECH_LOOK = 'tpl-speech-standard'

/** 発言テロップの見た目として選べる型(テロップの型のうち「発言」の分類) */
export const SPEECH_LOOK_TEMPLATES = TELOP_TEMPLATES.filter((t) => t.category === 'speech')

/**
 * 自動で入れる発言テロップの見た目。`id` はテロップの型(`tpl-…`)か、登録したテロップスタイルの id。
 * 登録したスタイルを選んだときは `styleId` でつなぐ(スタイルを直すと発言テロップも揃って変わる)。
 * 見つからない id(消したスタイルなど)は既定の型にする
 */
export function speechLook(
  id: string | undefined,
  styles: readonly TelopStyleDef[]
): { style: TextStyle; styleId?: string } {
  const def = id ? styles.find((s) => s.id === id) : undefined
  if (def) return { style: def.style, styleId: def.id }
  const tpl =
    SPEECH_LOOK_TEMPLATES.find((t) => t.id === id) ??
    SPEECH_LOOK_TEMPLATES.find((t) => t.id === DEFAULT_SPEECH_LOOK)!
  return { style: tpl.style() }
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
      const style = applyLook(o.style, def.style, { keepPlacement: true })
      return JSON.stringify(style) === JSON.stringify(o.style) ? o : { ...o, style }
    }
    const auto = styleForSpeaker(styles, o.speaker)
    if (!auto) return o
    return {
      ...o,
      styleId: auto.id,
      style: applyLook(o.style, auto.style, { keepPlacement: true })
    }
  })
}

/** 見た目だけの鍵(置き場所は自動で動かすので比べない) */
const lookKey = (s: TextStyle): string =>
  JSON.stringify({ ...s, position: undefined, rotation: undefined, customPosition: undefined })

/**
 * 自動で入れた発言テロップの見た目を、選び直した `next` に替える。
 * 前の見た目(`prev`)のままの枚だけを替え、手で見た目を変えた枚・話者にスタイルを割り当てた枚は残す。
 * 置き場所(顔を避けて上へ移したもの・手で動かしたもの)はそのまま
 */
export function restyleSpeechTelops(
  overlays: readonly TextOverlay[],
  prev: { style: TextStyle; styleId?: string },
  next: { style: TextStyle; styleId?: string },
  styles: readonly TelopStyleDef[]
): TextOverlay[] {
  const prevKey = lookKey(prev.style)
  return overlays.map((o) => {
    if (!isAutoSpeech(o)) return o
    if (styleForSpeaker(styles, o.speaker)) return o
    const following = prev.styleId
      ? o.styleId === prev.styleId
      : !o.styleId && lookKey(o.style) === prevKey
    if (!following) return o
    return {
      ...o,
      style: applyLook(o.style, next.style, { keepPlacement: true }),
      styleId: next.styleId
    }
  })
}

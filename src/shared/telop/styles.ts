import type { TextOverlay, TextStyle } from '../types'
import { TELOP_TEMPLATES } from './templates'
import { stackSimultaneousTelops, stackedBottomTelops } from './stack'

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

/**
 * 新しく作る発言テロップの見た目。自由配置は縦書きの見た目(右端に置く)のときだけ使う。
 * 横書きのスタイルに残っている自由配置(動かしたテロップから作ったスタイルなど)を使うと、
 * 声の重なったテロップが段に積まれず、顔・HUD も避けられなくなる
 */
export function speechTelopStyle(look: TextStyle): TextStyle {
  if (look.vertical) return { ...look }
  const { customPosition: _drop, ...rest } = look
  void _drop
  return rest
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
  styles: readonly TelopStyleDef[],
  /** 画面(テロップのキャンバス)の高さ。渡すと、声の重なった発言テロップを積み直す */
  canvasH?: number
): TextOverlay[] {
  const prevKey = lookKey(prev.style)
  const from = speechTelopStyle(prev.style).customPosition
  const to = speechTelopStyle(next.style).customPosition
  // 段に積んだ(重なりを避けて自動で1段上げた)枚も、見た目の既定の置き場所にある枚と同じに扱う
  const stacked = canvasH ? stackedBottomTelops(overlays, canvasH) : overlays.map(() => false)
  const restyled = new Set<number>()
  const out = overlays.map((o, i) => {
    if (!isAutoSpeech(o)) return o
    if (styleForSpeaker(styles, o.speaker)) return o
    const following = prev.styleId
      ? o.styleId === prev.styleId
      : !o.styleId && lookKey(o.style) === prevKey
    if (!following) return o
    // 前の見た目の置き場所のままの枚(縦書きの右端・段に積んだ枚)は、新しい見た目の置き場所へ。
    // 顔・HUD を避けて動かした枚・手で動かした枚は、その置き場所を残す
    const own = o.style.customPosition
    const samePlace =
      stacked[i] ||
      own === from ||
      (own !== undefined && from !== undefined && own.x === from.x && own.y === from.y)
    const style = applyLook(o.style, next.style, { keepPlacement: true })
    if (samePlace) {
      if (to) style.customPosition = { ...to }
      else delete style.customPosition
      restyled.add(i)
    }
    return { ...o, style, styleId: next.styleId }
  })
  if (!canvasH || to || restyled.size === 0) return out
  // 既定の置き場所(下)へ戻した枚を、声の重なりで積み直す。ほかの話者の枚・段に積まれていた枚も
  // 一緒に積み直す(選び直した枚だけを積むと、同時に出ているほかの枚と同じ段に重なる)。
  // 手で置いた枚・顔や HUD を避けた枚は、そのまま
  // 積み直すのは自動の発言テロップだけ(人が置いたテロップには触れない)
  const managed = out.map((o, i) => restyled.has(i) || (stacked[i] && isAutoSpeech(o)))
  const strip = (o: TextOverlay): TextOverlay => {
    if (!o.style.customPosition) return o
    const { customPosition: _drop, ...style } = o.style
    void _drop
    return { ...o, style }
  }
  const again = stackSimultaneousTelops(
    out.map((o, i) => (managed[i] ? strip(o) : o)),
    canvasH
  )
  return out.map((o, i) => {
    if (!managed[i]) return o
    const a = again[i]
    const same = JSON.stringify(a.style.customPosition) === JSON.stringify(o.style.customPosition)
    return restyled.has(i) || !same ? a : o
  })
}

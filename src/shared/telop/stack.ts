import type { TextOverlay } from '../types'
import { TEXT_MARGIN_V_RATIO } from '../textStyle'
import { bubbleTailReach, TELOP_LINE_HEIGHT_EM, telopHitBounds, type TelopContext } from './render'

/**
 * 同時に出ている下のテロップを、段に積んで重ならないようにする(計画書 §5.8 の「テロップ同士の重なりを避ける」)。
 *
 * 掛け合いで声が重なると、2人の発言テロップが同じ時間に出る。どちらも既定の位置(下)のままだと
 * 文字が重なって読めない。先に出ているものを下の段に残し、後から出たものを1段上に置く。
 * 段の高さはそのテロップの行数と文字の大きさから測る(キャンバスの高さに対する比で置く)。
 *
 * 手で置き場所を決めたテロップ(自由配置)と、下以外のテロップには触れない。
 *
 * `baseCenter`(キャンバスの高さに対する比)を渡すと、一番下の段もその高さ(段の中心)に自由配置で置き、
 * 上の段はそこから積む(ゲーム画面の HUD を避けて、発言テロップの段をまとめて上げるとき)。
 */

const GAP_RATIO = 0.015

/**
 * 文字の幅の見積もり(画面の無い所でも段の高さを測れるように)。全角は1文字ぶん、半角は約半分。
 * 折り返しの行数・行の高さ・ルビ・背景の余白は、描くときと同じ配置(`telopHitBounds`)で数える
 */
const estimateCtx: Pick<TelopContext, 'measureText' | 'font'> = {
  font: '',
  measureText(ch: string) {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 40)
    return { width: size * halfWidthEm(ch) } as TextMetrics
  }
}

/**
 * 半角の文字の幅(文字の大きさに対する比)の見積もり。少し広めに見る(狭く見ると折り返しを見落とし、
 * 上の段が下の段に重なる。太字の W は 0.94・M は 0.83 だった)
 */
function halfWidthEm(ch: string): number {
  if (!/[\x20-\x7e]/.test(ch)) return 1
  if (/[WM]/.test(ch)) return 0.95
  if (/[mw]/.test(ch)) return 0.9
  if (/[A-Z]/.test(ch)) return 0.8
  if (/[\sIijlt.,:;'!|]/.test(ch)) return 0.35
  return 0.62
}

/** キャンバスの幅(縦長なら 9:16、横長なら 16:9。テロップのキャンバスはこの2つ) */
function canvasWidthFor(canvasH: number): number {
  return canvasH > 1500 ? Math.round((canvasH * 9) / 16) : Math.round((canvasH * 16) / 9)
}

/**
 * 段の高さ(キャンバスの高さに対する比)。行数を改行の数で数えると、長い発言が自動で折り返して
 * 2行になったときに低く見積もり、上の段が下の段の1行目に重なっていた
 */
function blockHeightRatio(
  o: Pick<TextOverlay, 'text' | 'style'>,
  canvasH: number,
  canvasW: number,
  legacy: boolean | 'noTail' = false
): number {
  // 以前の数え方(改行の数 × 文字の大きさ × 行の高さ)。前に積んで保存した段を見分けるのに使う
  if (legacy === true)
    return (
      (Math.max(1, o.text.split('\n').length) * o.style.fontSize * TELOP_LINE_HEIGHT_EM) / canvasH
    )
  const bounds = telopHitBounds(
    estimateCtx,
    { text: o.text, style: o.style, startTime: 0, endTime: 1 },
    { w: canvasW, h: canvasH }
  )
  const lines = Math.max(1, o.text.split('\n').length)
  // 吹き出しの尻尾を段の高さに入れる前に積んだ段を見分けるときは、尻尾を除く
  if (legacy === 'noTail') {
    const tail = bubbleTailReach(o.style)
    bounds.h -= tail.top + tail.bottom
  }
  // 見積もりが壊れた値なら、従来の数え方
  const h =
    Number.isFinite(bounds.h) && bounds.h > 0
      ? bounds.h
      : lines * o.style.fontSize * TELOP_LINE_HEIGHT_EM
  return h / canvasH
}

export function stackSimultaneousTelops<
  T extends Pick<TextOverlay, 'text' | 'style' | 'startTime' | 'endTime'>
>(
  telops: readonly T[],
  canvasH: number,
  options: { baseCenter?: number; canvasW?: number; legacyHeights?: boolean | 'noTail' } = {}
): T[] {
  const canvasW = options.canvasW ?? canvasWidthFor(canvasH)
  const order = telops
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.startTime - b.t.startTime || a.i - b.i)
  const out = [...telops]
  // 段ごとに、今そこに出ているテロップ(終わりの時刻と高さ)
  const active: { end: number; top: number }[] = []
  for (const { t, i } of order) {
    if (t.style.position !== 'bottom' || t.style.customPosition) continue
    // 終わったものを外す
    for (let k = active.length - 1; k >= 0; k--)
      if (active[k].end <= t.startTime + 1e-6) active.splice(k, 1)
    const h = blockHeightRatio(t, canvasH, canvasW, options.legacyHeights)
    if (active.length === 0) {
      const base = options.baseCenter
      if (base === undefined) {
        active.push({ end: t.endTime, top: 1 - TEXT_MARGIN_V_RATIO - h })
      } else {
        out[i] = { ...t, style: { ...t.style, customPosition: { x: 0.5, y: base } } }
        active.push({ end: t.endTime, top: base - h / 2 })
      }
      continue
    }
    // いま出ている中で一番上の段の、さらに上に置く
    const top = Math.min(...active.map((a) => a.top))
    const center = top - GAP_RATIO - h / 2
    out[i] = { ...t, style: { ...t.style, customPosition: { x: 0.5, y: center } } }
    active.push({ end: t.endTime, top: center - h / 2 })
  }
  return out
}

/**
 * 段に積まれた(`stackSimultaneousTelops` が置いた)下のテロップを見分ける。
 * 自由配置でも、積み直すと同じ位置になるものは段のテロップとみなす(手で置いたものは外れる)
 */
export function stackedBottomTelops<
  T extends Pick<TextOverlay, 'text' | 'style' | 'startTime' | 'endTime'>
>(telops: readonly T[], canvasH: number, options: { baseCenter?: number } = {}): boolean[] {
  const strip = (t: T): T => {
    if (t.style.position !== 'bottom' || t.style.customPosition?.x !== 0.5) return t
    const { customPosition: _drop, ...style } = t.style
    void _drop
    return { ...t, style: style as T['style'] }
  }
  const restacked = stackSimultaneousTelops(telops.map(strip), canvasH, options)
  // 段の高さの測り方を変える前に積んで保存した段も、段のテロップとして見分ける
  const legacy = stackSimultaneousTelops(telops.map(strip), canvasH, {
    ...options,
    legacyHeights: true
  })
  const same = (a: { x: number; y: number } | undefined, own: { x: number; y: number }): boolean =>
    Boolean(a) && Math.abs(a!.x - own.x) < 1e-9 && Math.abs(a!.y - own.y) < 1e-9
  // 吹き出しの尻尾を段の高さに入れる前に積んだ段も見分ける
  const noTail = telops.some((t) => t.style.backgroundShape === 'bubble' && t.style.bubbleTail)
    ? stackSimultaneousTelops(telops.map(strip), canvasH, { ...options, legacyHeights: 'noTail' })
    : restacked
  return telops.map((t, i) => {
    if (t.style.position !== 'bottom') return false
    const own = t.style.customPosition
    if (!own) return options.baseCenter === undefined
    if (own.x !== 0.5) return false
    return (
      same(restacked[i].style.customPosition, own) ||
      same(legacy[i].style.customPosition, own) ||
      same(noTail[i].style.customPosition, own)
    )
  })
}

/**
 * HUD を避けて段ごと上げた発言テロップ(`placeTelopsAvoidingHud`)の、一番下の段の高さ。
 * 下の発言テロップの2枚以上が同じ高さ(真ん中・自由配置)にあり、そこから積み直すと今の置き場所に
 * なるなら、その高さ。無ければ undefined
 */
export function hudStackBase<
  T extends Pick<TextOverlay, 'text' | 'style' | 'startTime' | 'endTime'>
>(telops: readonly T[], canvasH: number): number | undefined {
  // HUD を避けて上げたあとは、下の発言テロップがどれも自由配置になる。既定の下のままの枚が
  // 1枚でもあれば、HUD の段ではない(一番下の段を消した・顔を避けて上へ移した、ふつうの積んだ段)
  if (telops.some((t) => t.style.position === 'bottom' && !t.style.customPosition)) return undefined
  const ys = telops
    .filter((t) => t.style.position === 'bottom' && t.style.customPosition?.x === 0.5)
    .map((t) => t.style.customPosition!.y)
  if (ys.length < 2) return undefined
  const base = Math.max(...ys)
  if (ys.filter((y) => y === base).length < 2) return undefined
  const managed = stackedBottomTelops(telops, canvasH, { baseCenter: base })
  return telops.some((t, i) => managed[i] && t.style.customPosition?.y === base) ? base : undefined
}

/** 縦型ショートで、下の発言テロップの下端をここ(画面の高さに対する比)より上に置く */
export const SHORTS_TELOP_BOTTOM = 0.82

/**
 * 縦型ショートの下の発言テロップを、YouTube Shorts の下部の帯(チャンネル名・説明文。高さの 84〜94%)
 * より上へ上げる。既定の位置(下端が 92%)のままだと帯に完全に隠れ、自動で作ったショートは確認の
 * 画面を通らずにそのまま書き出されるので、隠れたまま公開されていた。
 * 既定の位置のものは下端を `limit` に揃え、同時に出ていて上に積んであるもの(`stackSimultaneousTelops`
 * の段)は、画面のどこにあっても同じだけ上へずらす(積んだ間隔はそのまま。画面の下半分の段だけを
 * ずらすと、高い段が真ん中をまたいだとき、ずらさなかった段に下の段が重なった)。
 * それ以外の自由配置(縦書きの発言など)も、下端が帯にかかるなら下端を `limit` まで上げる
 */
export function liftAboveShortsUi<
  T extends Pick<TextOverlay, 'text' | 'style' | 'startTime' | 'endTime'>
>(telops: readonly T[], canvasH: number, options: { canvasW?: number; limit?: number } = {}): T[] {
  const canvasW = options.canvasW ?? canvasWidthFor(canvasH)
  const limit = options.limit ?? SHORTS_TELOP_BOTTOM
  const lift = 1 - TEXT_MARGIN_V_RATIO - limit
  if (!(lift > 0)) return [...telops]
  const tiers = stackedBottomTelops(telops, canvasH)
  return telops.map((t, i) => {
    const pos = t.style.customPosition
    if (!pos) {
      if (t.style.position !== 'bottom') return t
      const h = blockHeightRatio(t, canvasH, canvasW)
      return { ...t, style: { ...t.style, customPosition: { x: 0.5, y: limit - h / 2 } } }
    }
    const h = blockHeightRatio(t, canvasH, canvasW)
    const y = tiers[i] ? pos.y - lift : pos.y
    // 画面より高い(帯の上に収まらない)ものは、上端が画面の外へ出ない所まで(元より下げない)
    const fitted = Math.min(y, Math.max(limit - h / 2, Math.min(pos.y, h / 2)))
    if (Math.abs(fitted - pos.y) <= 1e-12) return t
    return { ...t, style: { ...t.style, customPosition: { ...pos, y: fitted } } }
  })
}

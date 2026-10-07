import type { TextOverlay } from '../types'
import { TEXT_MARGIN_V_RATIO } from '../textStyle'
import { TELOP_LINE_HEIGHT_EM } from './render'

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

function blockHeightRatio(o: Pick<TextOverlay, 'text' | 'style'>, canvasH: number): number {
  const lines = Math.max(1, o.text.split('\n').length)
  return (lines * o.style.fontSize * TELOP_LINE_HEIGHT_EM) / canvasH
}

export function stackSimultaneousTelops<
  T extends Pick<TextOverlay, 'text' | 'style' | 'startTime' | 'endTime'>
>(telops: readonly T[], canvasH: number, options: { baseCenter?: number } = {}): T[] {
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
    const h = blockHeightRatio(t, canvasH)
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
>(telops: readonly T[], canvasH: number): boolean[] {
  const strip = (t: T): T => {
    if (t.style.position !== 'bottom' || t.style.customPosition?.x !== 0.5) return t
    const { customPosition: _drop, ...style } = t.style
    void _drop
    return { ...t, style: style as T['style'] }
  }
  const restacked = stackSimultaneousTelops(telops.map(strip), canvasH)
  return telops.map((t, i) => {
    if (t.style.position !== 'bottom') return false
    const own = t.style.customPosition
    if (!own) return true
    if (own.x !== 0.5) return false
    const again = restacked[i].style.customPosition
    return Boolean(again) && Math.abs(again!.x - own.x) < 1e-9 && Math.abs(again!.y - own.y) < 1e-9
  })
}

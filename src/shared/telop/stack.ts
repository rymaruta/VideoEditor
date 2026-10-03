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
 */

const GAP_RATIO = 0.015

function blockHeightRatio(o: Pick<TextOverlay, 'text' | 'style'>, canvasH: number): number {
  const lines = Math.max(1, o.text.split('\n').length)
  return (lines * o.style.fontSize * TELOP_LINE_HEIGHT_EM) / canvasH
}

export function stackSimultaneousTelops<
  T extends Pick<TextOverlay, 'text' | 'style' | 'startTime' | 'endTime'>
>(telops: readonly T[], canvasH: number): T[] {
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
      active.push({ end: t.endTime, top: 1 - TEXT_MARGIN_V_RATIO - h })
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

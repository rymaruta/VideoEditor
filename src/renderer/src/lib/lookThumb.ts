import type { TextStyle } from '@shared/types'
import { drawTelop, layoutTelop, type TelopContext } from '@shared/telop/render'
import { stillTelopStyle } from './appearanceEdit'

/**
 * 見た目の小さな見本(見た目の一覧・項目ごとのマイ設定)と、その背景。
 * 書き出しと同じ `drawTelop` で描くので、見本どおりに出る。
 */

/** 見本の仮想キャンバスの基準(本物と同じ 16:9 の 1080) */
const BASE_CANVAS = { w: 1920, h: 1080 }

/** 写真のような落ち着いた背景(空 → 地面)。白い文字・黒い文字どちらも見える明るさ */
export function paintBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#7d97ad')
  g.addColorStop(0.45, '#a9a395')
  g.addColorStop(0.62, '#6f7259')
  g.addColorStop(1, '#3d4236')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, w * 0.7)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(1, 'rgba(0,0,0,0.35)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, w, h)
}

/**
 * 見本を1枚描く(置き場所は無視して中央に、動きを終えた姿で)。
 * 見た目の一覧のほか、項目ごとのマイ設定の小さな見本にも使う。
 * `fill` は文字の塊が枠のどれだけを占めるまで寄るか。
 */
export function drawLookThumb(
  canvas: HTMLCanvasElement,
  text: string,
  style: TextStyle,
  fill = 0.8,
  maxZoom = 4
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: w, height: h } = canvas
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  paintBackdrop(ctx, w, h)
  ctx.restore()
  const centered: TextStyle = {
    ...stillTelopStyle(style),
    position: 'center',
    customPosition: undefined,
    rotation: 0,
    // 見本は登場の動きを終えた姿で見せる
    animation: 'none',
    charAnimation: undefined,
    exitAnimation: undefined
  }
  // 見本の枠の縦横比に合わせた仮想キャンバス(横長の見本で縦に潰れないように)
  const base = { w: BASE_CANVAS.h * (w / h), h: BASE_CANVAS.h }
  const source = { text: text || ' ', startTime: 0, endTime: 1e9, style: centered }
  // 小さな見本でも読めるよう、文字の塊が枠の 8 割ほどになるまで寄って描く
  // (仮想キャンバスを小さくする = 拡大。塊が収まる大きさなので折り返しは変わらない)
  const layout = layoutTelop(ctx as unknown as TelopContext, source, base)
  const reach =
    (style.outline ? style.outlineWidth : 0) +
    (style.extraStrokes ?? []).reduce((a, s) => a + s.width, 0)
  const bw = layout.blockWidth + reach * 2 + (style.background ? layout.fontSize : 0)
  const bh = layout.blockHeight + reach * 2 + (style.background ? layout.fontSize * 0.6 : 0)
  const zoom = Math.max(
    0.5,
    Math.min(
      maxZoom,
      (base.w * fill) / Math.max(1, bw),
      (base.h * Math.min(0.75, fill)) / Math.max(1, bh)
    )
  )
  drawTelop(
    ctx as unknown as TelopContext,
    source,
    1,
    { width: w, height: h },
    { w: base.w / zoom, h: base.h / zoom }
  )
}

import type { TextOverlay } from '../types'
import { TEXT_MARGIN_H_RATIO, TEXT_MARGIN_V_RATIO } from '../textStyle'
import { TELOP_LINE_HEIGHT_EM } from './render'

/**
 * 顔を隠さない位置へずらす(計画書 §5.8「配置の自動調整」)。
 *
 * 下に置くテロップの範囲(文字の行数・文字数・大きさから見積もる)が、映っている顔に掛かるなら上へ移す。
 * 上も顔に掛かるなら、下のまま「要確認」にする(どちらに置いても顔に掛かる画は、人が決める)。
 * 顔の枠は画面に対する比(0〜1)で受け取る。
 */

export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
  score: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 顔の何割が隠れたら「掛かる」とみなすか */
const COVER_RATIO = 0.15
const MIN_SCORE = 0.7

/** テロップが占める範囲(画面に対する比)。`position` を上書きして見積もれる */
export function telopRect(
  o: Pick<TextOverlay, 'text' | 'style'>,
  canvas: { w: number; h: number },
  position: 'top' | 'bottom' = o.style.position === 'top' ? 'top' : 'bottom'
): Rect {
  const lines = o.text.split('\n')
  const longest = Math.max(1, ...lines.map((l) => [...l].length))
  const fontPx = o.style.fontSize
  const w = Math.min(canvas.w * (1 - 2 * TEXT_MARGIN_H_RATIO), longest * fontPx * 1.05) / canvas.w
  const h = (lines.length * fontPx * TELOP_LINE_HEIGHT_EM) / canvas.h
  const y = position === 'top' ? TEXT_MARGIN_V_RATIO : 1 - TEXT_MARGIN_V_RATIO - h
  return { x: 0.5 - w / 2, y, w, h }
}

function coverage(face: FaceBox, r: Rect): number {
  const x1 = Math.max(face.x, r.x)
  const y1 = Math.max(face.y, r.y)
  const x2 = Math.min(face.x + face.w, r.x + r.w)
  const y2 = Math.min(face.y + face.h, r.y + r.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  return inter / Math.max(1e-9, face.w * face.h)
}

export function coversFace(r: Rect, faces: readonly FaceBox[]): boolean {
  return faces.some((f) => f.score >= MIN_SCORE && coverage(f, r) >= COVER_RATIO)
}

export type FaceDecision = 'keep' | 'moveTop' | 'review'

/**
 * 下のテロップをどうするか。自由配置・下以外のテロップは対象外(keep)。
 */
export function decideTelopPlacement(
  o: Pick<TextOverlay, 'text' | 'style'>,
  faces: readonly FaceBox[],
  canvas: { w: number; h: number }
): FaceDecision {
  if (o.style.position !== 'bottom' || o.style.customPosition) return 'keep'
  if (!coversFace(telopRect(o, canvas, 'bottom'), faces)) return 'keep'
  if (!coversFace(telopRect(o, canvas, 'top'), faces)) return 'moveTop'
  return 'review'
}

/**
 * 素材の絵が画面(テロップのキャンバス)のどこに収まるか(画面の比)。本編は縦横比を保って画面に収める
 * (16:9 の録画を 9:16 の企画に置くと、上下に黒い帯ができる)
 */
export function containRect(
  source: { width: number; height: number },
  canvas: { w: number; h: number }
): Rect {
  if (!(source.width > 0 && source.height > 0)) return { x: 0, y: 0, w: 1, h: 1 }
  const s = Math.min(canvas.w / source.width, canvas.h / source.height)
  const w = (source.width * s) / canvas.w
  const h = (source.height * s) / canvas.h
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

/** 素材の絵の中の比で表した顔の枠を、画面の比へ */
export function faceToCanvas(face: FaceBox, fit: Rect): FaceBox {
  return {
    ...face,
    x: fit.x + face.x * fit.w,
    y: fit.y + face.y * fit.h,
    w: face.w * fit.w,
    h: face.h * fit.h
  }
}

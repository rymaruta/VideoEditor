/**
 * YuNet(OpenCV の顔検出、2023mar 版)の出力を顔の枠にする。
 *
 * 入力は 640×640 の BGR(0〜255)。出力はストライド 8/16/32 ごとに
 * cls(顔らしさ)・obj(物らしさ)・bbox(中心のずれと幅・高さの対数)。
 * 点数は √(cls × obj)。重なった候補は IoU 0.3 で間引く(OpenCV の FaceDetectorYN と同じ)。
 */

export const YUNET_SIZE = 640
const STRIDES = [8, 16, 32] as const

export interface YunetOutputs {
  [name: string]: { data: ArrayLike<number> }
}

export interface PixelBox {
  x: number
  y: number
  w: number
  h: number
  score: number
}

function iou(a: PixelBox, b: PixelBox): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  return inter / Math.max(1e-9, a.w * a.h + b.w * b.h - inter)
}

/** 640×640 の入力画素での顔の枠(点数の高い順) */
export function decodeYunet(outputs: YunetOutputs, scoreThreshold = 0.6): PixelBox[] {
  const found: PixelBox[] = []
  for (const st of STRIDES) {
    const cls = outputs[`cls_${st}`]?.data
    const obj = outputs[`obj_${st}`]?.data
    const bb = outputs[`bbox_${st}`]?.data
    if (!cls || !obj || !bb) continue
    const cols = YUNET_SIZE / st
    for (let i = 0; i < cls.length; i++) {
      const c = Math.min(1, Math.max(0, cls[i]))
      const o = Math.min(1, Math.max(0, obj[i]))
      const score = Math.sqrt(c * o)
      if (score < scoreThreshold) continue
      const row = Math.floor(i / cols)
      const col = i % cols
      const cx = (col + bb[i * 4]) * st
      const cy = (row + bb[i * 4 + 1]) * st
      const w = Math.exp(bb[i * 4 + 2]) * st
      const h = Math.exp(bb[i * 4 + 3]) * st
      found.push({ x: cx - w / 2, y: cy - h / 2, w, h, score })
    }
  }
  found.sort((a, b) => b.score - a.score)
  const kept: PixelBox[] = []
  for (const f of found) if (kept.every((k) => iou(k, f) < 0.3)) kept.push(f)
  return kept
}

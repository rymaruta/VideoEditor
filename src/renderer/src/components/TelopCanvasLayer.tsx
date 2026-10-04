import { useEffect, useRef, useState } from 'react'
import { loadTelopFonts } from '../lib/telopFonts'
import type { AspectRatio, TextOverlay } from '@shared/types'
import { textCanvasSize } from '@shared/resolution'
import { drawTelop, type TelopContext } from '@shared/telop/render'

/**
 * プレビューのテロップを**共通テロップレンダラ**で描く層。
 *
 * 長尺向けの書き出しは同じ `drawTelop` で描いた画像を重ねるので、ここで見える絵が
 * そのまま書き出される(DOM + CSS と ASS の2系統を揃える必要が無い)。
 * 操作(ドラッグで動かす)は従来の DOM の箱が受け持ち、この層はマウスを素通しする。
 */
export function TelopCanvasLayer({
  overlays,
  time,
  frameWidth,
  frameHeight,
  aspectRatio
}: {
  overlays: TextOverlay[]
  time: number
  frameWidth: number
  frameHeight: number
  aspectRatio: AspectRatio
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  // 同梱フォントを読み込み終えたら描き直す(最初の1回は代わりの書体で描かれる)
  const [fontsReady, setFontsReady] = useState(0)
  useEffect(() => {
    let alive = true
    void loadTelopFonts(overlays).then((loaded) => {
      if (alive && loaded) setFontsReady((n) => n + 1)
    })
    return () => {
      alive = false
    }
  }, [overlays])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || frameWidth <= 0 || frameHeight <= 0) return
    // 画面の画素の細かさで描く(縁取りの細い線がにじまないように)
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(frameWidth * dpr)
    const h = Math.round(frameHeight * dpr)
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    const textCanvas = textCanvasSize(aspectRatio)
    for (const o of overlays) {
      drawTelop(ctx as TelopContext, o, time, { width: w, height: h }, textCanvas)
    }
  }, [overlays, time, frameWidth, frameHeight, aspectRatio, fontsReady])

  return <canvas ref={ref} className="telop-canvas-layer" />
}

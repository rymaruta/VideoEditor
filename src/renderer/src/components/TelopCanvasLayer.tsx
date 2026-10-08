import { useEffect, useMemo, useRef, useState } from 'react'
import { loadTelopFonts } from '../lib/telopFonts'
import type { AspectRatio, TextOverlay } from '@shared/types'
import { textCanvasSize } from '@shared/resolution'
import { drawTelop, telopVisualKey, type TelopContext } from '@shared/telop/render'

/**
 * プレビューのテロップを**共通テロップレンダラ**で描く層。
 *
 * 書き出しは(どの方式でも)同じ `drawTelop` で描いた画像を重ねるので、ここで見える絵が
 * そのまま書き出される(DOM + CSS と ASS の2系統を揃える必要が無い)。
 * 操作(ドラッグで動かす)は従来の DOM の箱が受け持ち、この層はマウスを素通しする。
 *
 * 再生中は毎フレーム描き直しを頼まれるが、**絵が変わらないフレームは描かない**。
 * テロップは出ている間ほとんど止まっている(動くのは出入り・ループ・カラオケの切り替わりだけ)ので、
 * 前に描いたときと同じテロップ(同じ値)・同じ動きの状態(`telopVisualKey`)・同じ大きさなら
 * Canvas をそのまま残す。書き出しの層(`planTelopRuns`)が同じ鍵で「同じ絵」を決めているので、
 * ここで描かなかったフレームも書き出しと同じ絵のまま。
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
  // 読み込むフォントは書体・太さ・文字で決まる。親は毎フレーム新しい配列を渡してくるので、
  // 配列ではなく中身で見る(配列で見ると、再生中は毎フレーム読み込みの確認が走っていた)
  const fontKey = useMemo(
    () =>
      overlays
        .map(
          (o) =>
            `${o.style.fontFamily}|${o.style.fontWeight ?? ''}|${o.style.bold}|${o.style.italic}|${o.text}`
        )
        .join('\n'),
    [overlays]
  )
  useEffect(() => {
    let alive = true
    void loadTelopFonts(overlays).then((loaded) => {
      if (alive && loaded) setFontsReady((n) => n + 1)
    })
    return () => {
      alive = false
    }
    // `overlays` の中身のうち読み込みに効くものは `fontKey` に全部入っている
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontKey])

  // ブラウザが別の所で書体を読み終えたとき(代わりの書体で描いた後に本来の書体が届いたとき)も描き直す。
  // 止めているプレビューが、代わりの書体のまま残っていた
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    const onDone = (): void => setFontsReady((n) => n + 1)
    fonts?.addEventListener?.('loadingdone', onDone)
    return () => fonts?.removeEventListener?.('loadingdone', onDone)
  }, [])

  /** 最後に描いた絵の中身(同じなら描き直さない) */
  const drawn = useRef<{ overlays: TextOverlay[]; keys: string[]; frame: string } | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || frameWidth <= 0 || frameHeight <= 0) return
    // 画面の画素の細かさで描く(縁取りの細い線がにじまないように)
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(frameWidth * dpr)
    const h = Math.round(frameHeight * dpr)
    const textCanvas = textCanvasSize(aspectRatio)
    const visible = overlays.filter((o) => time >= o.startTime && time < o.endTime)
    const keys = visible.map((o) => telopVisualKey(o, time, textCanvas.h))
    const frame = `${w}x${h}|${aspectRatio}|${fontsReady}`
    const last = drawn.current
    if (
      last &&
      last.frame === frame &&
      last.overlays.length === visible.length &&
      last.overlays.every((o, i) => o === visible[i] && last.keys[i] === keys[i])
    ) {
      return
    }
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    for (const o of visible) {
      drawTelop(ctx as TelopContext, o, time, { width: w, height: h }, textCanvas)
    }
    drawn.current = { overlays: visible, keys, frame }
  }, [overlays, time, frameWidth, frameHeight, aspectRatio, fontsReady])

  return <canvas ref={ref} className="telop-canvas-layer" />
}

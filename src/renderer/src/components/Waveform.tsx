import { useEffect, useRef, useState } from 'react'

/** 外側の山を、まわりの何列ぶんの大きい方で取るか(1列 = 1px) */
const PEAK_REACH = 4

/**
 * 1列ごとの音の大きさ(中心からの高さ)を、ffmpeg の絵から読み取る。
 * 絵は `showwavespic` の既定(列ごとの平均)で、中心から上下へ対称に塗られている。
 */
function columnLevels(alpha: Uint8ClampedArray, w: number, h: number): Float32Array {
  const levels = new Float32Array(w)
  const center = (h - 1) / 2
  for (let x = 0; x < w; x++) {
    let top = -1
    let bottom = -1
    for (let y = 0; y < h; y++) {
      if (alpha[(y * w + x) * 4 + 3] > 24) {
        if (top < 0) top = y
        bottom = y
      }
    }
    levels[x] = top < 0 ? 0 : Math.max(center - top, bottom - center) + 0.5
  }
  return levels
}

/**
 * Graphite 2 の二重の波形: 外側に山(濃い色)・内側に平均(明るい色)。
 * 届く絵は列ごとの平均だけなので、外側の山は「まわり数列のうち大きい方」で取る
 * (本当の最大値は書き出し側で別に読む必要がある。それまでの近い見え方)。
 */
function drawLayered(canvas: HTMLCanvasElement, img: HTMLImageElement): void {
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (w <= 0 || h <= 0) return
  const read = document.createElement('canvas')
  read.width = w
  read.height = h
  const rctx = read.getContext('2d', { willReadFrequently: true })
  const ctx = canvas.getContext('2d')
  if (!rctx || !ctx) return
  rctx.drawImage(img, 0, 0)
  const levels = columnLevels(rctx.getImageData(0, 0, w, h).data, w, h)
  canvas.width = w
  canvas.height = h
  const style = getComputedStyle(canvas)
  const peakColor = style.getPropertyValue('--ve-wave-peak').trim() || '#2f6b50'
  const rmsColor = style.getPropertyValue('--ve-wave-rms').trim() || '#7bddae'
  const mid = h / 2
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = peakColor
  for (let x = 0; x < w; x++) {
    let peak = levels[x]
    for (let k = 1; k <= PEAK_REACH; k++) {
      if (x - k >= 0) peak = Math.max(peak, levels[x - k])
      if (x + k < w) peak = Math.max(peak, levels[x + k])
    }
    if (peak > 0) ctx.fillRect(x, mid - peak, 1, peak * 2)
  }
  ctx.fillStyle = rmsColor
  for (let x = 0; x < w; x++) {
    const level = levels[x]
    if (level > 0) ctx.fillRect(x, mid - level, 1, level * 2)
  }
}

export function Waveform({
  filePath,
  start,
  end,
  width,
  height
}: {
  filePath: string
  start: number
  end: number
  width: number
  height: number
}): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    // Debounced: props (especially start/end) can change on every mousemove while
    // trim-dragging a clip, and firing an ffmpeg subprocess per frame would flood
    // the system. Only the value the drag settles on actually needs a fetch.
    const request = (attempt: number): void => {
      window.api
        .generateWaveform(filePath, start, end, Math.round(width), Math.round(height))
        .then((dataUrl) => {
          if (!cancelled) setUrl(dataUrl)
        })
        .catch((e: unknown) => {
          // 待ちが溢れて後回しの頼みが捨てられた(スクロール中に新しいクリップが大量に見えた)。
          // まだ画面にあるなら、少し待って頼み直す(諦めると、その波形はずっと空のまま)
          if (!cancelled && String(e).includes('MEDIA_JOB_DROPPED') && attempt < 5) {
            timer = setTimeout(() => request(attempt + 1), 400 * (attempt + 1))
            return
          }
          // **取れなかったら、前の絵を消す。**
          //
          // 失敗を握り潰すだけだと `url` が前の範囲のまま残り、**別の範囲の波形が
          // その場所の波形として出続ける**。利用者から見て古いとは分からないので、
          // 「音が入っている」と読めてしまう。
          // (実測: 映像5秒・音声2秒の素材——録画物ではよくある形——で、
          //  範囲 1.0〜2.0(大きい音)→ 0.0〜1.0(小さい音)へトリムすると絵は
          //  ちゃんと変わる(指紋 1135b111 → 51c1a231)。そこから音声の無い
          //  2.5〜5.0 へトリムすると `generateWaveform` は失敗するのに、
          //  画面は **51c1a231 のまま**——直前の 0.0〜1.0 の波形が残っていた)
          //
          // 消したあとは「波形なし」になる。これは**その範囲を最初から開いたとき**と
          // 同じ見え方で、実際にそこには音が無い。
          // 掴んでいる最中の見え方は変えない——`url` を消すのは**失敗したときだけ**で、
          // 待っている 150ms の間は前の絵のままにしてある(でないとトリム中に点滅する)。
          if (!cancelled) setUrl(null)
        })
    }
    timer = setTimeout(() => request(0), 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [filePath, start, end, width, height])

  // 届いた絵を、山と平均の二重に描き直す(描けない環境では元の絵をそのまま出す)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [layered, setLayered] = useState(true)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!url || !canvas) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      try {
        drawLayered(canvas, img)
      } catch {
        setLayered(false)
      }
    }
    img.src = url
    return () => {
      cancelled = true
    }
  }, [url])

  if (!url) return null
  if (!layered) return <img className="waveform-img" src={url} alt="" draggable={false} />
  return <canvas ref={canvasRef} className="waveform-img waveform-canvas" aria-hidden="true" />
}

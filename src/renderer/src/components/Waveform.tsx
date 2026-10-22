import { useEffect, useRef, useState } from 'react'
import {
  columnLevels,
  liftLevels,
  peakColumnSpan,
  peakEnvelope,
  waveformDensity,
  WAVEFORM_HEIGHT_SCALE,
  tileReadRange,
  waveformTiles,
  type WaveTile
} from '../lib/waveformTiles'
import { isWavePeaks, type WavePeaks } from '@shared/waveformPeaks'

/** 波形の色の組(CSS の --ve-wave-* を選ぶ)。変われば描き直す */
export type WaveformVariant = 'audio' | 'auto' | 'video'

/**
 * ほどいた絵(URL ごと)。同じ絵を何度もほどかない。古いものから捨てる。
 * `decode()` で待つので、大きな絵でもほどく間に画面を止めない。
 */
const decoded = new Map<string, Promise<HTMLImageElement>>()
const DECODED_LIMIT = 64

function decodeOnce(url: string): Promise<HTMLImageElement> {
  const hit = decoded.get(url)
  if (hit) {
    decoded.delete(url)
    decoded.set(url, hit)
    return hit
  }
  const img = new Image()
  img.src = url
  const p = img.decode().then(() => img)
  p.catch(() => decoded.delete(url))
  decoded.set(url, p)
  while (decoded.size > DECODED_LIMIT) {
    const oldest = decoded.keys().next().value
    if (oldest === undefined) break
    decoded.delete(oldest)
  }
  return p
}

/** タイルごとの大きさ(平均と山)。絵ごとに持ち、絵が捨てられれば一緒に消える */
const levelsCache = new WeakMap<
  HTMLImageElement,
  Map<number, { rms: Float32Array; peak: Float32Array }>
>()
let readCanvas: HTMLCanvasElement | null = null

function tileLevels(
  img: HTMLImageElement,
  tile: WaveTile
): { rms: Float32Array; peak: Float32Array } {
  let perImage = levelsCache.get(img)
  if (!perImage) {
    perImage = new Map()
    levelsCache.set(img, perImage)
  }
  const hit = perImage.get(tile.x)
  if (hit) return hit
  const total = img.naturalWidth
  const h = img.naturalHeight
  const { sx, sw, offset } = tileReadRange(tile, total)
  if (!readCanvas) readCanvas = document.createElement('canvas')
  if (readCanvas.width < sw) readCanvas.width = sw
  if (readCanvas.height !== h) readCanvas.height = h
  const ctx = readCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('canvas unavailable')
  ctx.clearRect(0, 0, sw, h)
  ctx.drawImage(img, sx, 0, sw, h, 0, 0, sw, h)
  // 平方根で持ち上げてから山を取る(小さい音も読め、尖りは残る)
  const levels = liftLevels(columnLevels(ctx.getImageData(0, 0, sw, h).data, sw, h), (h - 1) / 2)
  const peak = peakEnvelope(levels)
  const result = {
    rms: levels.slice(offset, offset + tile.w),
    peak: peak.slice(offset, offset + tile.w)
  }
  perImage.set(tile.x, result)
  return result
}

/**
 * Graphite 2 の二重の波形の 1 タイル: 外側に山(濃い色)・内側に平均(明るい色)。
 * 届く絵は列ごとの平均だけなので、外側の山は「となりの列と比べて大きい方」で取る
 * (本当の最大値は書き出し側で別に読む必要がある。それまでの近い見え方)。
 */
function drawTile(canvas: HTMLCanvasElement, img: HTMLImageElement, tile: WaveTile): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  const { rms, peak } = tileLevels(img, tile)
  const h = img.naturalHeight
  if (canvas.width !== tile.w) canvas.width = tile.w
  if (canvas.height !== h) canvas.height = h
  const style = getComputedStyle(canvas)
  const mid = h / 2
  ctx.clearRect(0, 0, tile.w, h)
  // Graphite 3 のレーンの色(--g3-wave-*)があればそれを、無ければ Graphite 2 の色を使う
  const color = (name: string, fallback: string): string =>
    style.getPropertyValue(`--g3-wave-${name}`).trim() ||
    style.getPropertyValue(`--ve-wave-${name}`).trim() ||
    fallback
  ctx.fillStyle = color('peak', '#2f6b50')
  for (let x = 0; x < tile.w; x++) if (peak[x] > 0) ctx.fillRect(x, mid - peak[x], 1, peak[x] * 2)
  ctx.fillStyle = color('rms', '#7bddae')
  for (let x = 0; x < tile.w; x++) if (rms[x] > 0) ctx.fillRect(x, mid - rms[x], 1, rms[x] * 2)
}

/**
 * 細かい波形の 1 タイル: 列ごとの値(最大・最小・RMS)から、上下非対称の外側の山と内側の RMS を描く。
 * L/R があれば上下 2 段に分ける。振幅は平方根で持ち上げる(`peakColumnSpan`)
 */
function drawPeakTile(
  canvas: HTMLCanvasElement,
  peaks: WavePeaks,
  tile: WaveTile,
  height: number
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  const h = Math.max(8, Math.round(height))
  if (canvas.width !== tile.w) canvas.width = tile.w
  if (canvas.height !== h) canvas.height = h
  const style = getComputedStyle(canvas)
  const color = (name: string, fallback: string): string =>
    style.getPropertyValue(`--g3-wave-${name}`).trim() ||
    style.getPropertyValue(`--ve-wave-${name}`).trim() ||
    fallback
  ctx.clearRect(0, 0, tile.w, h)
  const band = h / peaks.channels.length
  const peakColor = color('peak', '#2f6b50')
  const rmsColor = color('rms', '#7bddae')
  peaks.channels.forEach((ch, i) => {
    const cy = band * i + band / 2
    const amp = band / 2 - 0.5
    const spans: ReturnType<typeof peakColumnSpan>[] = []
    for (let x = 0; x < tile.w; x++) {
      const k = tile.x + x
      spans.push(peakColumnSpan(ch.max[k], ch.min[k], ch.rms[k], cy, amp))
    }
    ctx.fillStyle = peakColor
    spans.forEach((s, x) => {
      if (s.bottom - s.top > 0.01) ctx.fillRect(x, s.top, 1, Math.max(0.6, s.bottom - s.top))
    })
    ctx.fillStyle = rmsColor
    spans.forEach((s, x) => {
      if (s.rmsBottom - s.rmsTop > 0.01) ctx.fillRect(x, s.rmsTop, 1, s.rmsBottom - s.rmsTop)
    })
  })
}

/**
 * 横にスクロールする一番近い祖先(タイムラインの `.track-lanes-col` など)。
 * IntersectionObserver の root に渡さないと、rootMargin(先読み)が効かない
 */
function scrollRootOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

/** 1 タイル。画面に見えている(近い)ときだけ描く */
function WaveTileCanvas({
  source,
  draw,
  x,
  w,
  total,
  variant,
  onFail
}: {
  /** 描く元(絵、または列ごとの値)。替われば描き直す */
  source: object
  draw: (canvas: HTMLCanvasElement, tile: WaveTile) => void
  x: number
  w: number
  total: number
  variant: WaveformVariant
  onFail: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    // 左右に少し余裕を持たせ、横に送ったときに描き終わっているようにする
    const io = new IntersectionObserver(
      (entries) => setVisible(entries.some((e) => e.isIntersecting)),
      {
        root: scrollRootOf(el),
        rootMargin: '0px 512px'
      }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const onFailRef = useRef(onFail)
  useEffect(() => {
    onFailRef.current = onFail
  })
  // 描いてある絵(見えていない間に絵が替わったら中を消し、古い波形を見せない)
  const drawnRef = useRef<{ source: object; x: number; w: number; variant: string } | null>(null)
  const drawRef = useRef(draw)
  useEffect(() => {
    drawRef.current = draw
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const drawn = drawnRef.current
    if (!visible) {
      if (drawn && (drawn.source !== source || drawn.x !== x || drawn.w !== w)) {
        el.getContext('2d')?.clearRect(0, 0, el.width, el.height)
        drawnRef.current = null
      }
      return
    }
    try {
      drawRef.current(el, { x, w })
      drawnRef.current = { source, x, w, variant }
    } catch {
      onFailRef.current()
    }
    // variant が変われば色を読み直して描き直す
  }, [visible, source, x, w, variant])
  return (
    <canvas
      ref={ref}
      className="waveform-tile"
      aria-hidden="true"
      style={{ left: `${(x / total) * 100}%`, width: `${(w / total) * 100}%` }}
    />
  )
}

export function Waveform({
  filePath,
  start,
  end,
  width,
  height,
  variant = 'audio'
}: {
  filePath: string
  start: number
  end: number
  width: number
  height: number
  /** 色の組。自動の SE・BGM は 'auto'、本編クリップは 'video' */
  variant?: WaveformVariant
}): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)
  // ほどいた絵と、二重に描けなかった絵の URL(下の描き直しで使う)
  const [image, setImage] = useState<{ url: string; img: HTMLImageElement } | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  // 細かい波形の値(取れたらこちらで描く)と、描けなかった値
  const [peaks, setPeaks] = useState<WavePeaks | null>(null)
  const [failedPeaks, setFailedPeaks] = useState<WavePeaks | null>(null)
  // 値で描けなかった(canvas が使えない等)。以後は絵の波形を頼む
  const [imageOnly, setImageOnly] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    // Debounced: props (especially start/end) can change on every mousemove while
    // trim-dragging a clip, and firing an ffmpeg subprocess per frame would flood
    // the system. Only the value the drag settles on actually needs a fetch.
    const columns = Math.round(width * waveformDensity(width))
    // まず細かい波形の値(列ごとの最大・最小・RMS、L/R 別)を頼む。取れない(古い main・音が読めない・
    // 形が違う)ときは、今までの絵の波形へ戻る
    const request = (attempt: number): void => {
      const fetchPeaks = window.api.generateWaveformPeaks
      if (imageOnly || typeof fetchPeaks !== 'function') {
        requestImage(0)
        return
      }
      fetchPeaks(filePath, start, end, columns)
        .then((p) => {
          if (cancelled) return
          if (isWavePeaks(p)) {
            setPeaks(p)
          } else {
            setPeaks(null)
            requestImage(0)
          }
        })
        .catch((e: unknown) => {
          if (cancelled) return
          if (String(e).includes('MEDIA_JOB_DROPPED') && attempt < 5) {
            timer = setTimeout(() => request(attempt + 1), 400 * (attempt + 1))
            return
          }
          setPeaks(null)
          requestImage(0)
        })
    }
    const requestImage = (attempt: number): void => {
      // 1 画面 px に 2 列・縦も 2 倍の細かい絵を頼む(描く時に枠へ縮める。細い線が並ぶ見え方)
      window.api
        .generateWaveform(
          filePath,
          start,
          end,
          Math.round(width * waveformDensity(width)),
          Math.round(height * WAVEFORM_HEIGHT_SCALE)
        )
        .then((dataUrl) => {
          if (!cancelled) setUrl(dataUrl)
        })
        .catch((e: unknown) => {
          // 待ちが溢れて後回しの頼みが捨てられた(スクロール中に新しいクリップが大量に見えた)。
          // まだ画面にあるなら、少し待って頼み直す(諦めると、その波形はずっと空のまま)
          if (!cancelled && String(e).includes('MEDIA_JOB_DROPPED') && attempt < 5) {
            timer = setTimeout(() => requestImage(attempt + 1), 400 * (attempt + 1))
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
          // ほどいた絵も消す(次に絵が届くまでの間に、前の範囲の波形を出さない)
          if (!cancelled) {
            setUrl(null)
            setImage(null)
          }
        })
    }
    timer = setTimeout(() => request(0), 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [filePath, start, end, width, height, imageOnly])

  // 届いた絵をほどき、山と平均の二重に描き直す(描けなかった絵は元の絵をそのまま出す)。
  // 描けなかった印は URL ごと(新しい絵になれば、また二重で描いてみる)
  useEffect(() => {
    if (!url) return
    let cancelled = false
    decodeOnce(url).then(
      (img) => {
        if (!cancelled) setImage({ url, img })
      },
      () => {
        if (!cancelled) setFailedUrl(url)
      }
    )
    return () => {
      cancelled = true
    }
  }, [url])

  if (peaks && failedPeaks !== peaks) {
    const failedFor = peaks
    const canvasHeight = height * WAVEFORM_HEIGHT_SCALE
    return (
      <div className="waveform-img waveform-tiles" data-variant={variant} data-fine="true">
        {waveformTiles(peaks.columns).map((tile) => (
          <WaveTileCanvas
            key={tile.x}
            source={peaks}
            draw={(el, t) => drawPeakTile(el, peaks, t, canvasHeight)}
            x={tile.x}
            w={tile.w}
            total={peaks.columns}
            variant={variant}
            onFail={() => {
              setFailedPeaks(failedFor)
              setImageOnly(true)
            }}
          />
        ))}
      </div>
    )
  }
  if (!url) return null
  if (failedUrl === url) return <img className="waveform-img" src={url} alt="" draggable={false} />
  // 新しい絵をほどいている間は前の絵のまま(トリム中に点滅しない)
  if (!image) return null
  const total = image.img.naturalWidth
  const tiles = waveformTiles(total)
  const failedFor = image.url
  return (
    <div className="waveform-img waveform-tiles" data-variant={variant}>
      {tiles.map((tile) => (
        <WaveTileCanvas
          key={tile.x}
          source={image.img}
          draw={(el, t) => drawTile(el, image.img, t)}
          x={tile.x}
          w={tile.w}
          total={total}
          variant={variant}
          onFail={() => setFailedUrl(failedFor)}
        />
      ))}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import {
  columnLevels,
  liftLevels,
  peakColumnSpan,
  peakEnvelope,
  WAVEFORM_DENSITY,
  WAVEFORM_AMP_SHARE,
  WAVEFORM_HEIGHT_SCALE,
  WAVEFORM_SPLIT_MIN_HEIGHT,
  WAVEFORM_TILE_WIDTH,
  mergedColumn,
  tileReadRange,
  waveformTiles,
  waveformImageRequestSize,
  ByteLimitedCache,
  releaseCanvas,
  type WaveTile
} from '../lib/waveformTiles'
import {
  WAVE_PEAKS_ABORTED,
  isWavePeaks,
  wavePeaksBytes,
  type WavePeaks
} from '@shared/waveformPeaks'

/** 波形の色の組(CSS の --ve-wave-* を選ぶ)。変われば描き直す */
export type WaveformVariant = 'audio' | 'auto' | 'video'

/**
 * ほどいた絵(URL ごと)。同じ絵を何度もほどかない。古いものから捨てる。
 * 上限は大きさ(ほどいた絵の画素 × 4 バイト + URL の長さ)の合計で持つ(数だけだと、長いクリップの
 * 大きな絵が溜まって画面のメモリが膨らんでいた)。`decode()` で待つので、ほどく間に画面を止めない。
 */
const DECODED_LIMIT = 64
const DECODED_MAX_BYTES = 48 * 1024 * 1024
const decoded = new ByteLimitedCache<Promise<HTMLImageElement>>(DECODED_MAX_BYTES, DECODED_LIMIT)

function decodeOnce(url: string): Promise<HTMLImageElement> {
  const hit = decoded.get(url)
  if (hit) return hit
  const img = new Image()
  img.src = url
  const p = img.decode().then(() => {
    // ほどけたら本当の大きさで数え直す(まだ覚えている時だけ)
    if (decoded.get(url) === p)
      decoded.set(url, p, url.length + img.naturalWidth * img.naturalHeight * 4)
    return img
  })
  p.catch(() => decoded.delete(url))
  decoded.set(url, p, url.length)
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
  // 上限はレーンの高さの 80%(絵の中の高さを縮めてから持ち上げる)
  const half = (h - 1) / 2
  const raw = columnLevels(ctx.getImageData(0, 0, sw, h).data, sw, h)
  const levels = liftLevels(raw, half).map((v) => v * WAVEFORM_AMP_SHARE)
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
  ctx.fillStyle = color('peak', 'rgba(230, 244, 236, 0.35)')
  for (let x = 0; x < tile.w; x++) if (peak[x] > 0) ctx.fillRect(x, mid - peak[x], 1, peak[x] * 2)
  ctx.fillStyle = color('rms', 'rgba(230, 244, 236, 0.85)')
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
  // 低いレーン(48px 未満)は L と R を 1 本に重ねる。高いレーンは上下 2 段
  const merge = height < WAVEFORM_SPLIT_MIN_HEIGHT && peaks.channels.length > 1
  const rows = merge ? 1 : peaks.channels.length
  const band = h / rows
  const peakColor = color('peak', 'rgba(230, 244, 236, 0.35)')
  const rmsColor = color('rms', 'rgba(230, 244, 236, 0.85)')
  for (let i = 0; i < rows; i++) {
    const ch = peaks.channels[i]
    const cy = band * i + band / 2
    // 振幅 1 でも段の高さの 80% まで
    const amp = (band / 2) * WAVEFORM_AMP_SHARE
    const spans: ReturnType<typeof peakColumnSpan>[] = []
    for (let x = 0; x < tile.w; x++) {
      const k = tile.x + x
      const v = merge
        ? mergedColumn(peaks.channels, k)
        : { max: ch.max[k], min: ch.min[k], rms: ch.rms[k] }
      spans.push(peakColumnSpan(v.max, v.min, v.rms, cy, amp))
    }
    ctx.fillStyle = peakColor
    spans.forEach((s, x) => {
      if (s.bottom - s.top > 0.01) ctx.fillRect(x, s.top, 1, Math.max(0.6, s.bottom - s.top))
    })
    ctx.fillStyle = rmsColor
    spans.forEach((s, x) => {
      if (s.rmsBottom - s.rmsTop > 0.01) ctx.fillRect(x, s.rmsTop, 1, s.rmsBottom - s.rmsTop)
    })
  }
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
      // 見えなくなったタイルは中身を捨てる(描いた絵の記憶を放す。見えたらまた描く)
      if (drawn) {
        releaseCanvas(el)
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

/**
 * 値の波形のタイル(2048 列ずつ)の覚え場所。**仮の絵にだけ使う**: 見えたらすぐこれを描き、
 * main にも毎回頼んで、届いた値で描き直す(同じパスに上書きした素材で古い波形を出し続けない。
 * main は素の値から集計するだけなので速い)。
 * 上限は大きさの合計(1 枚 2048 列 × 2ch × 3 値 × 4 バイト ≒ 49KB。32MB で約 650 枚)
 */
const peakTileCache = new ByteLimitedCache<WavePeaks>(32 * 1024 * 1024, 4000)
let peakRequestSeq = 0

/** 見えている範囲の外に、前後これだけのタイルを余分に置く(送ったときに描き終わっているように) */
const TILE_MARGIN = 1

/**
 * 値の波形の 1 タイル。見えている(近い)間だけ、そのタイルの範囲・列数を main に頼んで描く。
 * 見えなくなったら描いた中身を捨て、走っている頼み(前の拡大の段など)は止める
 */
function PeakTile({
  filePath,
  t0,
  t1,
  x,
  w,
  total,
  height,
  variant,
  onFail
}: {
  filePath: string
  /** このタイルが受け持つ素材の時刻(秒) */
  t0: number
  t1: number
  x: number
  w: number
  total: number
  height: number
  variant: WaveformVariant
  onFail: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
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
  const key = `${filePath}|${t0}|${t1}|${w}`
  const [got, setGot] = useState<{ key: string; peaks: WavePeaks } | null>(null)
  // 描く値: 届いたもの、または覚え場所にあるもの(無ければ前に描いた絵のまま。トリム中に点滅しない)
  const shown = got && got.key === key ? got.peaks : (peakTileCache.peek(key) ?? null)
  // 頼む: 見えている間だけ。掴んで動かしている間(トリム)は落ち着いてから(150ms)
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let done = false
    let id = ''
    let timer: ReturnType<typeof setTimeout>
    const request = (attempt: number): void => {
      id = `wp${++peakRequestSeq}`
      done = false
      window.api
        .generateWaveformPeaks(filePath, t0, t1, w, id)
        .then((p) => {
          done = true
          if (cancelled) return
          if (!isWavePeaks(p)) {
            onFailRef.current()
            return
          }
          peakTileCache.set(key, p, wavePeaksBytes(p))
          // 届いた値で描き直す(仮の絵が上書き前の素材のものでも、ここで今の中身になる)
          setGot({ key, peaks: p })
        })
        .catch((e: unknown) => {
          done = true
          if (cancelled) return
          const msg = String(e)
          // 止めた・捨てられた頼みでは絵の波形へ切り替えない。見えている間だけ間を空けて頼み直す
          // (回数で諦めない。諦めると、その波形はずっと空のまま。見えなくなれば頼み自体が止まる)
          if (msg.includes(WAVE_PEAKS_ABORTED) || msg.includes('MEDIA_JOB_DROPPED')) {
            timer = setTimeout(() => request(attempt + 1), Math.min(2000, 400 * (attempt + 1)))
            return
          }
          onFailRef.current()
        })
    }
    timer = setTimeout(() => request(0), 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
      // 要らなくなった頼み(見えなくなった・範囲や拡大の段が変わった)は main で止める
      if (id && !done) void window.api.cancelWaveformPeaks?.(id).catch(() => {})
    }
  }, [visible, key, filePath, t0, t1, w])
  // 描く・捨てる
  const drawnRef = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!visible) {
      // 見えなくなったタイルは中身を捨てる(描いた絵の記憶を放す。見えたらまた描く)
      if (drawnRef.current) {
        releaseCanvas(el)
        drawnRef.current = false
        delete el.dataset.drawn
      }
      return
    }
    if (!shown) return
    try {
      drawPeakTile(el, shown, { x: 0, w: shown.columns }, height)
      drawnRef.current = true
      // 何を描いたか(試験・実測で「今の範囲の絵か」を見分ける)
      el.dataset.drawn = key
    } catch {
      onFailRef.current()
    }
    // variant が変われば色を読み直して描き直す
  }, [visible, shown, height, variant, key])
  return (
    <canvas
      ref={ref}
      data-key={key}
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
  variant = 'audio',
  viewFrom = 0,
  viewTo = 1
}: {
  filePath: string
  start: number
  end: number
  width: number
  height: number
  /** 色の組。自動の SE・BGM は 'auto'、本編クリップは 'video' */
  variant?: WaveformVariant
  /**
   * クリップの幅のうち画面に見えている所(0〜1)。見えているタイルだけを置いて頼む
   * (3 時間のクリップの最大拡大は 1700 枚近いタイルになる)
   */
  viewFrom?: number
  viewTo?: number
}): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)
  // ほどいた絵と、二重に描けなかった絵の URL(下の描き直しで使う)
  const [image, setImage] = useState<{ url: string; img: HTMLImageElement } | null>(null)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  // 値の波形が使えない(古い main・音が読めない・描けない)。以後は絵の波形を頼む
  const [imageOnly, setImageOnly] = useState(
    () => typeof window.api?.generateWaveformPeaks !== 'function'
  )

  useEffect(() => {
    if (!imageOnly) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    // Debounced: props (especially start/end) can change on every mousemove while
    // trim-dragging a clip, and firing an ffmpeg subprocess per frame would flood
    // the system. Only the value the drag settles on actually needs a fetch.
    const requestImage = (attempt: number): void => {
      // 1 画面 px に 2 列・縦も 2 倍の細かい絵を頼む(描く時に枠へ縮める。細い線が並ぶ見え方)。
      // ffmpeg の絵の上限を越えない大きさで頼む(越えると絵が作られず波形が消えていた)
      const size = waveformImageRequestSize(width, height)
      window.api
        .generateWaveform(filePath, start, end, size.width, size.height)
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
    timer = setTimeout(() => requestImage(0), 150)
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

  if (!imageOnly) {
    // 値の波形: 1 画面 px に 2 列。見えている所(と前後 1 枚)のタイルだけを置く
    const total = Math.max(1, Math.round(width * WAVEFORM_DENSITY))
    const span = end - start
    const tiles = waveformTiles(total)
    const from = Math.max(0, Math.min(1, viewFrom)) * total
    const to = Math.max(0, Math.min(1, viewTo)) * total
    const margin = WAVEFORM_TILE_WIDTH * TILE_MARGIN
    return (
      <div className="waveform-img waveform-tiles" data-variant={variant} data-fine="true">
        {tiles
          .filter((tile) => tile.x + tile.w >= from - margin && tile.x <= to + margin)
          .map((tile) => (
            <PeakTile
              key={tile.x}
              filePath={filePath}
              t0={start + (span * tile.x) / total}
              t1={start + (span * (tile.x + tile.w)) / total}
              x={tile.x}
              w={tile.w}
              total={total}
              height={height * WAVEFORM_HEIGHT_SCALE}
              variant={variant}
              onFail={() => setImageOnly(true)}
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

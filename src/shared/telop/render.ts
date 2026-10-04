import type { FontFamily, TextStyle, TranscriptWord } from '../types'
import {
  TEXT_ANIMATION_MS,
  TEXT_FADE_IN_MS,
  TEXT_SHADOW_OFFSET_PX,
  TEXT_SHADOW_OPACITY,
  textBoxPaddingPx,
  textMarginHPx,
  textMarginVPx,
  textSlideOffsetPx
} from '../textStyle'
import { isKaraokeWordSung, karaokeWords } from '../captionWords'

/**
 * 共通テロップレンダラ。**画面のプレビューと書き出しが同じ関数で描く。**
 * 計画書: `docs/VARIETY_AUTO_EDIT_PLAN.md` §4.4
 *
 * これまでテロップは、画面は DOM + CSS、書き出しは ASS + libass と**別の描画系**で描いていた。
 * 位置・余白・縁取り・影・アニメーションを1つずつ実測して揃えてきたが(各定数のコメント参照)、
 * 描画系が2つある限り「片方だけ直す」は無くならない。ここでは Canvas 2D の1つの関数で描き、
 * 画面はそのまま枠に、書き出しは同じ絵を画像にして重ねる。
 *
 * 数字の意味は従来どおり: `fontSize` などはテロップの仮想キャンバス(`textCanvasSize`)上の px で、
 * 実際の枠へは `枠の幅 / キャンバスの幅` を掛けて描く。位置・余白・アニメーションの長さも
 * 従来の共通定数(`@shared/textStyle`)から取るので、ASS の書き出しと同じ場所・同じ動きになる。
 *
 * 従来の描画系に無かった装飾(`extraStrokes` の多重縁・`gradientColor` の縦グラデーション)も
 * ここでだけ描ける。
 */

/** Canvas の 2D 文脈のうち、ここで使うものだけ(DOM の canvas と OffscreenCanvas の両方で通る) */
export type TelopContext = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'translate'
  | 'rotate'
  | 'scale'
  | 'measureText'
  | 'fillText'
  | 'strokeText'
  | 'fillRect'
  | 'createLinearGradient'
> & {
  font: string
  fillStyle: CanvasRenderingContext2D['fillStyle']
  strokeStyle: CanvasRenderingContext2D['strokeStyle']
  lineWidth: number
  lineJoin: CanvasLineJoin
  miterLimit: number
  globalAlpha: number
  textBaseline: CanvasTextBaseline
  textAlign: CanvasTextAlign
}

/** 描くテロップ(v1 の `TextOverlay` と同じ形。時刻は秒) */
export interface TelopSource {
  text: string
  startTime: number
  endTime: number
  style: TextStyle
  words?: TranscriptWord[]
}

export const TELOP_FONT_STACKS: Record<FontFamily, string> = {
  'sans-serif': 'sans-serif',
  serif: 'serif',
  'M PLUS Rounded 1c': '"M PLUS Rounded 1c", sans-serif',
  'Noto Sans JP': '"Noto Sans JP", sans-serif',
  'Noto Serif JP': '"Noto Serif JP", serif'
}

/** 行の高さ(文字サイズに対する比) */
export const TELOP_LINE_HEIGHT_EM = 1.2

/** タイプライターで1文字が出る間隔(ms)。従来の書き出し(`buildTypewriterText`)と同じ */
export const TYPEWRITER_CHAR_MS = 40

const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback)
const positive = (v: number, fallback: number): number =>
  Number.isFinite(v) && v > 0 ? v : fallback

/** 描く先ごとに、最後に入れた書体の指定と、そのときの `ctx.font` の値 */
const fontState = new WeakMap<object, { requested: string; actual: string }>()

/**
 * `ctx.font` を入れる。**同じ書体ならもう一度入れない。**
 * Chromium は代入のたびに書体を解決し直し、ページの Web フォントの状態によっては
 * 1回に 0.4〜2 秒かかる(実測: 30分の回で、シークのたびに画面が 1〜2.3 秒止まった。
 * 原因は1枚ごとに2回入れていた `700 40px sans-serif`)。
 * 描く先の大きさを変えると `ctx.font` は既定に戻るので、今の値も比べて確かめる。
 */
export function setCanvasFont(ctx: Pick<TelopContext, 'font'>, font: string): void {
  const last = fontState.get(ctx)
  if (last && last.requested === font && ctx.font === last.actual) return
  ctx.font = font
  fontState.set(ctx, { requested: font, actual: ctx.font })
}

export function telopFont(style: TextStyle, sizePx: number): string {
  const family = TELOP_FONT_STACKS[style.fontFamily] ?? 'sans-serif'
  return `${style.italic ? 'italic ' : ''}${style.bold ? 700 : 400} ${sizePx}px ${family}`
}

// ------------------------------------------------------------------ 折り返し

/** 1文字ずつの並び。カラオケのときは、どの単語に属するかも持つ */
interface Glyph {
  ch: string
  word: number
}

/**
 * 本文を枠の幅で折り返す。改行はそのまま行の区切りにする。
 * 和文は文字のあいだで折る。空白を含む並び(英文)は、行の中に空白があればそこで折る。
 */
export function wrapGlyphs(
  glyphs: readonly Glyph[],
  maxWidth: number,
  advance: (ch: string) => number
): Glyph[][] {
  const lines: Glyph[][] = []
  let line: Glyph[] = []
  let width = 0
  for (const g of glyphs) {
    if (g.ch === '\n') {
      lines.push(line)
      line = []
      width = 0
      continue
    }
    const w = advance(g.ch)
    if (line.length > 0 && width + w > maxWidth && g.ch !== ' ') {
      // 行の中に空白があれば、その後ろで折る(単語を割らない)
      const space = line.map((x) => x.ch).lastIndexOf(' ')
      if (space > 0 && /[\x21-\x7e]/.test(g.ch)) {
        const rest = line.slice(space + 1)
        lines.push(line.slice(0, space))
        line = rest
        width = rest.reduce((s, x) => s + advance(x.ch), 0)
      } else {
        lines.push(line)
        line = []
        width = 0
      }
    }
    line.push(g)
    width += w
  }
  lines.push(line)
  return lines
}

// ------------------------------------------------------------------ アニメーション

export interface TelopAnimationState {
  /** 不透明度 0〜1 */
  opacity: number
  /** アンカーを軸にした拡大率 */
  scale: number
  /** 縦の移動(キャンバス px、下が正) */
  offsetY: number
  /** タイプライターで見えている文字数(Infinity は全部) */
  visibleChars: number
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * Math.min(1, Math.max(0, t))

/**
 * 登場からの経過(秒)に対するアニメーションの状態。
 * 長さと動きは従来の書き出し(ASS の `\fad` `\t` `\move`)と同じ値・同じ折り返し点。
 */
export function telopAnimationAt(
  style: TextStyle,
  elapsedSec: number,
  canvasHeight: number
): TelopAnimationState {
  const ms = Math.max(0, finite(elapsedSec, 0) * 1000)
  const fadeMs = TEXT_FADE_IN_MS[style.animation] ?? 0
  const opacity = fadeMs > 0 ? Math.min(1, ms / fadeMs) : 1
  const total = TEXT_ANIMATION_MS[style.animation] ?? 0
  let scale = 1
  let offsetY = 0
  let visibleChars = Infinity
  switch (style.animation) {
    case 'popIn':
      scale = lerp(0.6, 1, ms / total)
      break
    case 'bounce': {
      const half = Math.round(total * 0.5)
      const dip = Math.round(total * 0.7)
      if (ms < half) scale = lerp(0.3, 1.15, ms / half)
      else if (ms < dip) scale = lerp(1.15, 0.92, (ms - half) / (dip - half))
      else scale = lerp(0.92, 1, (ms - dip) / (total - dip))
      break
    }
    case 'slideInUp':
    case 'slideInDown': {
      const offset = Math.round(textSlideOffsetPx(canvasHeight))
      const from = style.animation === 'slideInUp' ? offset : -offset
      offsetY = lerp(from, 0, ms / total)
      break
    }
    case 'typewriter':
      visibleChars = Math.floor(ms / TYPEWRITER_CHAR_MS) + 1
      break
  }
  return { opacity, scale, offsetY, visibleChars }
}

// ------------------------------------------------------------------ 配置

export interface TelopLayout {
  lines: { glyphs: Glyph[]; width: number }[]
  fontSize: number
  lineHeight: number
  /** ブロック全体の幅・高さ(キャンバス px) */
  blockWidth: number
  blockHeight: number
  /** アンカー(回転・拡大の軸)の位置(キャンバス px) */
  anchor: { x: number; y: number }
  /** アンカーに対するブロック上端の位置(アンカーからの縦の差) */
  topFromAnchor: number
}

/**
 * どこに何行で置くか。位置・余白は従来の書き出しと同じ規則:
 * - 上/下寄せは枠の上下から `TEXT_MARGIN_V_RATIO`、左右は `TEXT_MARGIN_H_RATIO` の余白の中で折り返す
 * - 自由配置(`customPosition`)はブロックの中心をその点に置く
 * - 回転・拡大の軸は配置のアンカー(下寄せなら下端中央、上寄せなら上端中央、ほかは中心)
 */
export function layoutTelop(
  ctx: Pick<TelopContext, 'measureText' | 'font'>,
  source: TelopSource,
  canvas: { w: number; h: number }
): TelopLayout {
  const style = source.style
  const fontSize = positive(style.fontSize, 1)
  const spacing = finite(style.letterSpacing, 0)
  setCanvasFont(ctx, telopFont(style, fontSize))
  const cache = new Map<string, number>()
  const advance = (ch: string): number => {
    let w = cache.get(ch)
    if (w === undefined) {
      w = ctx.measureText(ch).width + spacing
      cache.set(ch, w)
    }
    return w
  }
  const karaoke = karaokeWords(source)
  const glyphs: Glyph[] = karaoke
    ? karaoke.flatMap((w, i) => [...w.text].map((ch) => ({ ch, word: i })))
    : [...(source.text ?? '')].map((ch) => ({ ch, word: -1 }))
  const maxWidth = Math.max(1, canvas.w - textMarginHPx(canvas.w) * 2)
  const wrapped = wrapGlyphs(glyphs, maxWidth, advance)
  const lines = wrapped.map((g) => ({
    glyphs: g,
    width: g.reduce((s, x) => s + advance(x.ch), 0) - (g.length > 0 ? spacing : 0)
  }))
  const lineHeight = fontSize * TELOP_LINE_HEIGHT_EM
  const blockWidth = lines.reduce((m, l) => Math.max(m, l.width), 0)
  const blockHeight = lineHeight * lines.length
  const marginV = textMarginVPx(canvas.h)

  let anchor: { x: number; y: number }
  let topFromAnchor: number
  if (style.customPosition) {
    anchor = {
      x: finite(style.customPosition.x, 0.5) * canvas.w,
      y: finite(style.customPosition.y, 0.5) * canvas.h
    }
    topFromAnchor = -blockHeight / 2
  } else if (style.position === 'top') {
    anchor = { x: canvas.w / 2, y: marginV }
    topFromAnchor = 0
  } else if (style.position === 'bottom') {
    anchor = { x: canvas.w / 2, y: canvas.h - marginV }
    topFromAnchor = -blockHeight
  } else {
    anchor = { x: canvas.w / 2, y: canvas.h / 2 }
    topFromAnchor = -blockHeight / 2
  }
  return { lines, fontSize, lineHeight, blockWidth, blockHeight, anchor, topFromAnchor }
}

// ------------------------------------------------------------------ 描画

/** 文字の外側に描く縁(外側から順)。`width` は文字の輪郭から外へ伸びる量(累計) */
export function telopStrokeRings(style: TextStyle): { color: string; reach: number }[] {
  const rings: { color: string; reach: number }[] = []
  let reach = 0
  if (style.outline && positive(style.outlineWidth, 0) > 0) {
    reach += style.outlineWidth
    rings.push({ color: style.outlineColor, reach })
  }
  for (const s of style.extraStrokes ?? []) {
    const w = positive(s.width, 0)
    if (w <= 0) continue
    reach += w
    rings.push({ color: s.color, reach })
  }
  return rings.reverse()
}

/**
 * テロップを1枚描く。`ctx` は描く先の枠(`frame` px)に合わせてあること。
 * `timeSeconds` はシーケンス(またはタイムライン)上の時刻で、出ていない時刻なら何も描かない。
 */
export function drawTelop(
  ctx: TelopContext,
  source: TelopSource,
  timeSeconds: number,
  frame: { width: number; height: number },
  canvas: { w: number; h: number }
): void {
  if (!(timeSeconds >= source.startTime && timeSeconds < source.endTime)) return
  const style = source.style
  const anim = telopAnimationAt(style, timeSeconds - source.startTime, canvas.h)
  if (anim.opacity <= 0) return
  const layout = layoutTelop(ctx, source, canvas)
  const unit = frame.width / canvas.w
  const fs = layout.fontSize
  const spacing = finite(style.letterSpacing, 0)
  const rings = telopStrokeRings(style)
  const karaoke = karaokeWords(source)

  ctx.save()
  ctx.scale(unit, unit)
  ctx.translate(layout.anchor.x, layout.anchor.y + anim.offsetY)
  if (style.rotation) ctx.rotate((finite(style.rotation, 0) * Math.PI) / 180)
  if (anim.scale !== 1) ctx.scale(anim.scale, anim.scale)
  ctx.globalAlpha = anim.opacity
  setCanvasFont(ctx, telopFont(style, fs))
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  // 何文字目まで見せるか(タイプライター)
  let budget = anim.visibleChars
  const lines = layout.lines.map((l) => {
    const take = Math.max(0, Math.min(l.glyphs.length, budget))
    budget -= l.glyphs.length
    return { ...l, shown: l.glyphs.slice(0, take) }
  })

  const lineY = (i: number): number =>
    layout.topFromAnchor + layout.lineHeight * i + layout.lineHeight / 2
  const lineX = (width: number): number => -width / 2

  // 1. 背景箱(行ごと。従来の書き出しと同じ余白)
  if (style.background) {
    const pad = textBoxPaddingPx(fs)
    ctx.fillStyle = withAlpha(style.backgroundColor, finite(style.backgroundOpacity, 0.5))
    lines.forEach((l, i) => {
      if (l.glyphs.length === 0) return
      ctx.fillRect(
        lineX(l.width) - pad.x,
        lineY(i) - layout.lineHeight / 2 - pad.y,
        l.width + pad.x * 2,
        layout.lineHeight + pad.y * 2
      )
    })
  }

  const eachGlyph = (fn: (g: Glyph, x: number, y: number) => void): void => {
    lines.forEach((l, i) => {
      let x = lineX(l.width)
      const y = lineY(i)
      for (const g of l.shown) {
        fn(g, x, y)
        x += ctx.measureText(g.ch).width + spacing
      }
    })
  }

  // 2. 影(縁取りごと落とす。ぼかさない硬い影)
  if (style.shadow) {
    const o = TEXT_SHADOW_OFFSET_PX
    const outer = rings[0]?.reach ?? 0
    ctx.fillStyle = `rgba(0,0,0,${TEXT_SHADOW_OPACITY})`
    ctx.strokeStyle = `rgba(0,0,0,${TEXT_SHADOW_OPACITY})`
    ctx.lineWidth = outer * 2
    eachGlyph((g, x, y) => {
      if (outer > 0) ctx.strokeText(g.ch, x + o, y + o)
      ctx.fillText(g.ch, x + o, y + o)
    })
  }

  // 3. 縁(外側から)。線は輪郭の両側に半分ずつ乗るので、外へ伸ばしたい量の2倍の幅で引く
  for (const ring of rings) {
    ctx.strokeStyle = ring.color
    ctx.lineWidth = ring.reach * 2
    eachGlyph((g, x, y) => ctx.strokeText(g.ch, x, y))
  }

  // 4. 塗り
  lines.forEach((l, i) => {
    let x = lineX(l.width)
    const y = lineY(i)
    let fill: CanvasRenderingContext2D['fillStyle'] = style.color
    if (style.gradientColor) {
      const g = ctx.createLinearGradient(0, y - fs / 2, 0, y + fs / 2)
      g.addColorStop(0, style.color)
      g.addColorStop(1, style.gradientColor)
      fill = g
    }
    for (const g of l.shown) {
      const sung = karaoke && g.word >= 0 && isKaraokeWordSung(karaoke[g.word], timeSeconds)
      ctx.fillStyle = sung ? style.highlightColor : fill
      ctx.fillText(g.ch, x, y)
      x += ctx.measureText(g.ch).width + spacing
    }
  })
  ctx.restore()
}

/** `#rrggbb` に不透明度を掛けた `rgba()`。読めない色はそのまま返す */
export function withAlpha(hex: string, opacity: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const a = Math.min(1, Math.max(0, finite(opacity, 1)))
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/**
 * ある時刻の見た目を決める値をまとめた文字列。**同じ文字列なら同じ絵**になる。
 * 書き出しで、絵が変わる瞬間だけ描き直すのに使う(毎フレーム描かない)。
 */
export function telopVisualKey(
  source: TelopSource,
  timeSeconds: number,
  canvasHeight: number
): string {
  if (!(timeSeconds >= source.startTime && timeSeconds < source.endTime)) return ''
  const a = telopAnimationAt(source.style, timeSeconds - source.startTime, canvasHeight)
  const karaoke = karaokeWords(source)
  const sung = karaoke ? karaoke.filter((w) => isKaraokeWordSung(w, timeSeconds)).length : 0
  const chars = a.visibleChars === Infinity ? -1 : a.visibleChars
  return `${a.opacity.toFixed(3)}|${a.scale.toFixed(4)}|${a.offsetY.toFixed(2)}|${chars}|${sung}`
}

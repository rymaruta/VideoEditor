import type { FontFamily, TelopGradient, TelopSpanStyle, TextStyle, TranscriptWord } from '../types'
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
 * 装飾は Premiere のエッセンシャルグラフィックス・DaVinci の Text+ と同じ考え方で重ねる:
 * 背景(行ごとの帯・1枚の板・吹き出し。角丸・枠線・斜め・グラデーション)→ 光彩 → 影 →
 * 縁(何重でも。それぞれ単色かグラデーション)→ 塗り(単色かグラデーション)→ 矢印。
 * 文字の一部は `**強調**` `__小さく__` で、1行目は `firstLine` で、大きさと色を変えられる。
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
> &
  Partial<
    Pick<
      CanvasRenderingContext2D,
      | 'beginPath'
      | 'moveTo'
      | 'lineTo'
      | 'quadraticCurveTo'
      | 'arcTo'
      | 'closePath'
      | 'fill'
      | 'stroke'
    >
  > & {
    /** ぼかし(影・光彩)。無い描く先ではぼかさずに描く */
    filter?: string
    lineCap?: CanvasLineCap
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
  'Noto Serif JP': '"Noto Serif JP", serif',
  'Dela Gothic One': '"Dela Gothic One", "Noto Sans JP", sans-serif',
  'RocknRoll One': '"RocknRoll One", "Noto Sans JP", sans-serif',
  'Kosugi Maru': '"Kosugi Maru", "M PLUS Rounded 1c", sans-serif',
  'Zen Maru Gothic': '"Zen Maru Gothic", "M PLUS Rounded 1c", sans-serif',
  Yomogi: '"Yomogi", "M PLUS Rounded 1c", sans-serif',
  'Klee One': '"Klee One", "Noto Serif JP", serif',
  'Shippori Mincho': '"Shippori Mincho", "Noto Serif JP", serif'
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

/** 文字の太さ(`fontWeight` があればそれ、無ければ太字の ON/OFF) */
export function telopFontWeight(style: Pick<TextStyle, 'bold' | 'fontWeight'>): number {
  const w = style.fontWeight
  return typeof w === 'number' && Number.isFinite(w) ? w : style.bold ? 700 : 400
}

export function telopFont(style: TextStyle, sizePx: number): string {
  const family = TELOP_FONT_STACKS[style.fontFamily] ?? 'sans-serif'
  return `${style.italic ? 'italic ' : ''}${telopFontWeight(style)} ${sizePx}px ${family}`
}

// ------------------------------------------------------------------ 折り返し

/**
 * 1文字ずつの並び。カラオケのときは、どの単語に属するかも持つ。
 * `span` は `**強調**`(1)・`__小さく__`(2)・それ以外(0)、`first` は1行目(`firstLine` を当てる)
 */
export interface Glyph {
  ch: string
  word: number
  span?: 0 | 1 | 2
  first?: boolean
}

/**
 * 本文を枠の幅で折り返す。改行はそのまま行の区切りにする。
 * 和文は文字のあいだで折る。空白を含む並び(英文)は、行の中に空白があればそこで折る。
 */
export function wrapGlyphs(
  glyphs: readonly Glyph[],
  maxWidth: number,
  advance: (ch: string, glyph: Glyph) => number
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
    const w = advance(g.ch, g)
    if (line.length > 0 && width + w > maxWidth && g.ch !== ' ') {
      // 行の中に空白があれば、その後ろで折る(単語を割らない)
      const space = line.map((x) => x.ch).lastIndexOf(' ')
      if (space > 0 && /[\x21-\x7e]/.test(g.ch)) {
        const rest = line.slice(space + 1)
        lines.push(line.slice(0, space))
        line = rest
        width = rest.reduce((s, x) => s + advance(x.ch, x), 0)
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

// ------------------------------------------------------------------ 部分の装飾

/**
 * 本文の `**…**`(強調)・`__…__`(小さく)の印を外した文字列。
 * 書き出しの文字数の確認・一覧の表示など、印を見せたくない所で使う
 */
export function stripTelopMarkup(text: string): string {
  return (text ?? '').replace(/\*\*|__/g, '')
}

/** 本文を1文字ずつにし、印の中の文字に `span` を付ける。印そのものは描かない */
export function parseTelopMarkup(text: string): Glyph[] {
  const out: Glyph[] = []
  const chars = [...(text ?? '')]
  const multiLine = chars.includes('\n')
  let span: 0 | 1 | 2 = 0
  let first = multiLine
  for (let i = 0; i < chars.length; i++) {
    const pair = chars[i] + (chars[i + 1] ?? '')
    if (pair === '**' && span !== 2) {
      span = span === 1 ? 0 : 1
      i++
      continue
    }
    if (pair === '__' && span !== 1) {
      span = span === 2 ? 0 : 2
      i++
      continue
    }
    if (chars[i] === '\n') {
      out.push({ ch: '\n', word: -1 })
      first = false
      continue
    }
    out.push({ ch: chars[i], word: -1, ...(span ? { span } : {}), ...(first ? { first } : {}) })
  }
  return out
}

/** その文字に当てる部分の見た目(1行目 → 強調/小さく の順に重ねる) */
function spanStyleOf(style: TextStyle, g: Glyph): TelopSpanStyle | null {
  const parts = [
    g.first ? style.firstLine : undefined,
    g.span === 1 ? style.accent : g.span === 2 ? style.sub : undefined
  ].filter((x): x is TelopSpanStyle => Boolean(x))
  if (parts.length === 0) return null
  return {
    scale: parts.reduce((m, p) => m * positive(p.scale ?? 1, 1), 1),
    color: parts.reduce<string | undefined>((c, p) => p.color ?? c, undefined),
    gradient: parts.reduce<TelopGradient | undefined>((g2, p) => p.gradient ?? g2, undefined)
  }
}

// ------------------------------------------------------------------ 配置

/** 置いた1文字(行の左端からの位置と、大きさ) */
export interface PlacedGlyph extends Glyph {
  x: number
  size: number
  width: number
}

export interface TelopLayout {
  lines: {
    glyphs: PlacedGlyph[]
    width: number
    /** 行の上端(ブロックの上端から) */
    top: number
    height: number
    /** 行でいちばん大きい文字の大きさ */
    maxSize: number
  }[]
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

/** 行の高さの倍率 */
function lineHeightOf(style: TextStyle): number {
  const v = style.lineHeight
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : TELOP_LINE_HEIGHT_EM
}

/**
 * どこに何行で置くか。位置・余白は従来の書き出しと同じ規則:
 * - 上/下寄せは枠の上下から `TEXT_MARGIN_V_RATIO`、左右は `TEXT_MARGIN_H_RATIO` の余白の中で折り返す
 * - 自由配置(`customPosition`)はブロックの中心をその点に置く
 * - 回転・拡大の軸は配置のアンカー(下寄せなら下端中央、上寄せなら上端中央、ほかは中心)
 * 文字の大きさが行の中で違うとき(強調・1行目)は、行の高さはその行のいちばん大きい文字で決める
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
  // 大きさの違う文字は、本文の大きさで測った幅を倍率で伸ばす(書体の幅は大きさに比例する)。
  // 大きさごとに書体を入れ直すと Chromium では1回ごとに書体を解決し直して重い
  const baseAdvance = (ch: string): number => {
    let w = cache.get(ch)
    if (w === undefined) {
      w = ctx.measureText(ch).width
      cache.set(ch, w)
    }
    return w
  }
  const scaleOf = (g: Glyph): number => spanStyleOf(style, g)?.scale ?? 1
  const advance = (ch: string, g: Glyph): number => baseAdvance(ch) * scaleOf(g) + spacing
  const karaoke = karaokeWords(source)
  const glyphs: Glyph[] = karaoke
    ? karaoke.flatMap((w, i) => [...w.text].map((ch) => ({ ch, word: i })))
    : parseTelopMarkup(source.text ?? '')
  const maxWidth = Math.max(1, canvas.w - textMarginHPx(canvas.w) * 2)
  const wrapped = wrapGlyphs(glyphs, maxWidth, advance)
  const factor = lineHeightOf(style)
  let top = 0
  const lines = wrapped.map((g) => {
    let x = 0
    const placed: PlacedGlyph[] = g.map((glyph) => {
      const scale = scaleOf(glyph)
      const width = baseAdvance(glyph.ch) * scale
      const out = { ...glyph, x, size: fontSize * scale, width }
      x += width + spacing
      return out
    })
    const maxSize = placed.reduce((m, p) => Math.max(m, p.size), placed.length > 0 ? 0 : fontSize)
    const height = maxSize * factor
    const line = {
      glyphs: placed,
      width: x - (placed.length > 0 ? spacing : 0),
      top,
      height,
      maxSize
    }
    top += height
    return line
  })
  const lineHeight = fontSize * factor
  const blockWidth = lines.reduce((m, l) => Math.max(m, l.width), 0)
  const blockHeight = top
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

/** 文字の外側に描く縁(外側から順)。`reach` は文字の輪郭から外へ伸びる量(累計) */
export function telopStrokeRings(
  style: TextStyle
): { color: string; reach: number; gradient?: TelopGradient }[] {
  const rings: { color: string; reach: number; gradient?: TelopGradient }[] = []
  let reach = 0
  if (style.outline && positive(style.outlineWidth, 0) > 0) {
    reach += style.outlineWidth
    rings.push({
      color: style.outlineColor,
      reach,
      ...(style.outlineGradient ? { gradient: style.outlineGradient } : {})
    })
  }
  for (const s of style.extraStrokes ?? []) {
    const w = positive(s.width, 0)
    if (w <= 0) continue
    reach += w
    rings.push({ color: s.color, reach, ...(s.gradient ? { gradient: s.gradient } : {}) })
  }
  return rings.reverse()
}

/** 背景の余白(px) */
export function telopBackgroundPadding(
  style: TextStyle,
  fontSize: number
): { x: number; y: number } {
  const p = style.backgroundPadding
  return p ? { x: finite(p.x, 0), y: finite(p.y, 0) } : textBoxPaddingPx(fontSize)
}

/** 矩形 `r` に、向き `angle`(0 で上→下、90 で左→右)のグラデーションを掛ける */
function gradientFor(
  ctx: TelopContext,
  gradient: TelopGradient,
  r: { x: number; y: number; w: number; h: number }
): CanvasGradient {
  const rad = (finite(gradient.angle, 0) * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = Math.cos(rad)
  // CSS の linear-gradient と同じ長さ(角から角まで色が届く)
  const half = Math.abs((r.w / 2) * dx) + Math.abs((r.h / 2) * dy)
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
  for (const s of gradient.stops) g.addColorStop(Math.min(1, Math.max(0, s.at)), s.color)
  return g
}

/** 角丸・斜めの四角の輪郭を引く(`beginPath` から `closePath` まで) */
function boxPath(
  ctx: TelopContext,
  r: { x: number; y: number; w: number; h: number },
  radius: number,
  skewDeg: number,
  tail?: { side: 'top' | 'bottom' | 'left' | 'right'; at: number; length: number }
): void {
  const k = Math.tan((finite(skewDeg, 0) * Math.PI) / 180)
  // 斜めは、縦の中心を軸に上を右へ・下を左へずらす
  const sx = (y: number): number => -(y - (r.y + r.h / 2)) * k
  const P = (x: number, y: number): [number, number] => [x + sx(y), y]
  const rad = Math.max(0, Math.min(radius, r.w / 2, r.h / 2))
  const { x, y, w, h } = r
  const tailW = Math.min(
    tail ? Math.max(12, tail.length * 0.8) : 0,
    (tail?.side === 'left' || tail?.side === 'right' ? h : w) - rad * 2
  )
  ctx.beginPath!()
  ctx.moveTo!(...P(x + rad, y))
  // 上の辺
  if (tail?.side === 'top' && tailW > 0) {
    const c = x + rad + (w - rad * 2) * tail.at
    ctx.lineTo!(...P(c - tailW / 2, y))
    ctx.lineTo!(...P(c, y - tail.length))
    ctx.lineTo!(...P(c + tailW / 2, y))
  }
  ctx.lineTo!(...P(x + w - rad, y))
  ctx.arcTo!(...P(x + w, y), ...P(x + w, y + rad), rad)
  // 右の辺
  if (tail?.side === 'right' && tailW > 0) {
    const c = y + rad + (h - rad * 2) * tail.at
    ctx.lineTo!(...P(x + w, c - tailW / 2))
    ctx.lineTo!(...P(x + w + tail.length, c))
    ctx.lineTo!(...P(x + w, c + tailW / 2))
  }
  ctx.lineTo!(...P(x + w, y + h - rad))
  ctx.arcTo!(...P(x + w, y + h), ...P(x + w - rad, y + h), rad)
  // 下の辺
  if (tail?.side === 'bottom' && tailW > 0) {
    const c = x + rad + (w - rad * 2) * tail.at
    ctx.lineTo!(...P(c + tailW / 2, y + h))
    ctx.lineTo!(...P(c, y + h + tail.length))
    ctx.lineTo!(...P(c - tailW / 2, y + h))
  }
  ctx.lineTo!(...P(x + rad, y + h))
  ctx.arcTo!(...P(x, y + h), ...P(x, y + h - rad), rad)
  // 左の辺
  if (tail?.side === 'left' && tailW > 0) {
    const c = y + rad + (h - rad * 2) * tail.at
    ctx.lineTo!(...P(x, c + tailW / 2))
    ctx.lineTo!(...P(x - tail.length, c))
    ctx.lineTo!(...P(x, c - tailW / 2))
  }
  ctx.lineTo!(...P(x, y + rad))
  ctx.arcTo!(...P(x, y), ...P(x + rad, y), rad)
  ctx.closePath!()
}

/** 背景を、四角を塗るだけで描ける(角丸・斜め・枠線・グラデーション・吹き出しが無い) */
function isPlainBackground(style: TextStyle): boolean {
  return (
    (style.backgroundShape ?? 'lines') !== 'bubble' &&
    !(positive(style.backgroundRadius ?? 0, 0) > 0) &&
    !finite(style.backgroundSkew ?? 0, 0) &&
    !(style.backgroundBorder && positive(style.backgroundBorder.width, 0) > 0) &&
    !style.backgroundGradient
  )
}

/** 背景の矩形(ブロックの左上を原点にしない、アンカー基準の座標) */
function backgroundRects(
  style: TextStyle,
  layout: TelopLayout,
  lineX: (width: number) => number,
  blockTop: number
): { x: number; y: number; w: number; h: number }[] {
  const pad = telopBackgroundPadding(style, layout.fontSize)
  if ((style.backgroundShape ?? 'lines') === 'lines') {
    return layout.lines
      .filter((l) => l.glyphs.length > 0)
      .map((l) => ({
        x: lineX(l.width) - pad.x,
        y: blockTop + l.top - pad.y,
        w: l.width + pad.x * 2,
        h: l.height + pad.y * 2
      }))
  }
  const left = Math.min(...layout.lines.map((l) => lineX(l.width)))
  return [
    {
      x: left - pad.x,
      y: blockTop - pad.y,
      w: layout.blockWidth + pad.x * 2,
      h: layout.blockHeight + pad.y * 2
    }
  ]
}

/** 影の落とす向きと距離(キャンバス px)。既定は従来と同じ右下へ (o, o) */
function shadowOffset(style: TextStyle): { dx: number; dy: number } {
  if (style.shadowAngle === undefined && style.shadowDistance === undefined)
    return { dx: TEXT_SHADOW_OFFSET_PX, dy: TEXT_SHADOW_OFFSET_PX }
  const dist = finite(style.shadowDistance ?? TEXT_SHADOW_OFFSET_PX * Math.SQRT2, 0)
  const rad = (finite(style.shadowAngle ?? 45, 45) * Math.PI) / 180
  return { dx: Math.cos(rad) * dist, dy: Math.sin(rad) * dist }
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
  const rings = telopStrokeRings(style)
  const karaoke = karaokeWords(source)
  const baseAlpha = anim.opacity * Math.min(1, Math.max(0, finite(style.opacity ?? 1, 1)))
  // ぼかしは描く先の画素で効く(拡大縮小の影響を受けない)ので、枠と動きの倍率を掛ける
  const blurPx = (v: number): number => Math.max(0, v * unit * anim.scale)

  ctx.save()
  ctx.scale(unit, unit)
  ctx.translate(layout.anchor.x, layout.anchor.y + anim.offsetY)
  if (style.rotation) ctx.rotate((finite(style.rotation, 0) * Math.PI) / 180)
  if (anim.scale !== 1) ctx.scale(anim.scale, anim.scale)
  ctx.globalAlpha = baseAlpha
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

  const blockTop = layout.topFromAnchor
  const align = style.align ?? 'center'
  const lineX = (width: number): number =>
    align === 'left'
      ? -layout.blockWidth / 2
      : align === 'right'
        ? layout.blockWidth / 2 - width
        : -width / 2
  const lineCenterY = (i: number): number => blockTop + lines[i].top + lines[i].height / 2
  // 小さい文字は、大きい文字と下をそろえる(行の中心ではなく、ベースラインの近くへ下げる)
  const glyphY = (i: number, g: PlacedGlyph): number =>
    lineCenterY(i) + (lines[i].maxSize - g.size) * 0.38
  const lineRect = (i: number): { x: number; y: number; w: number; h: number } => ({
    x: lineX(lines[i].width),
    y: blockTop + lines[i].top + (lines[i].height - lines[i].maxSize) / 2,
    w: Math.max(1, lines[i].width),
    h: Math.max(1, lines[i].maxSize)
  })
  const blockRect = {
    x: Math.min(...lines.map((l) => lineX(l.width))),
    y: blockTop,
    w: Math.max(1, layout.blockWidth),
    h: Math.max(1, layout.blockHeight)
  }

  /** 大きさの違う文字ごとに書体を入れ替えながら、見えている文字を順に描く */
  let currentSize = fs
  const switchSize = (size: number): void => {
    if (size === currentSize) return
    currentSize = size
    setCanvasFont(ctx, telopFont(style, size))
  }
  const eachGlyph = (fn: (g: PlacedGlyph, x: number, y: number, line: number) => void): void => {
    lines.forEach((l, i) => {
      const left = lineX(l.width)
      for (const g of l.shown) {
        switchSize(g.size)
        fn(g, left + g.x, glyphY(i, g), i)
      }
    })
    switchSize(fs)
  }
  const sh = shadowOffset(style)
  const shadowAlpha = Math.min(
    1,
    Math.max(0, finite(style.shadowOpacity ?? TEXT_SHADOW_OPACITY, 0))
  )
  const shadowFill = withAlpha(style.shadowColor ?? '#000000', shadowAlpha)
  const shadowBlur = positive(style.shadowBlur ?? 0, 0)

  // 1. 背景
  if (style.background) {
    const rects = backgroundRects(style, layout, lineX, blockTop)
    const bgOpacity = Math.min(1, Math.max(0, finite(style.backgroundOpacity, 0.5)))
    if (isPlainBackground(style) && !style.shadow) {
      ctx.fillStyle = withAlpha(style.backgroundColor, bgOpacity)
      for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h)
    } else if (ctx.beginPath) {
      const radius = positive(style.backgroundRadius ?? 0, 0)
      const skew = finite(style.backgroundSkew ?? 0, 0)
      const tail = style.backgroundShape === 'bubble' ? style.bubbleTail : undefined
      const border = style.backgroundBorder
      const bw = border ? positive(border.width, 0) : 0
      // 板の影(影を付けたテロップは、板ごと落とす)
      if (style.shadow) {
        ctx.save()
        if (shadowBlur > 0) ctx.filter = `blur(${blurPx(shadowBlur)}px)`
        ctx.fillStyle = shadowFill
        for (const r of rects) {
          boxPath(ctx, { ...r, x: r.x + sh.dx, y: r.y + sh.dy }, radius, skew, tail)
          ctx.fill!()
        }
        ctx.restore()
      }
      for (const r of rects) {
        boxPath(ctx, r, radius, skew, tail)
        ctx.globalAlpha = baseAlpha * bgOpacity
        ctx.fillStyle = style.backgroundGradient
          ? gradientFor(ctx, style.backgroundGradient, r)
          : style.backgroundColor
        ctx.fill!()
        ctx.globalAlpha = baseAlpha
        if (bw > 0) {
          ctx.strokeStyle = border!.color
          ctx.lineWidth = bw
          ctx.stroke!()
        }
      }
    }
  }

  const outer = rings[0]?.reach ?? 0

  // 2. 光彩(縁ごとぼかした色で囲む)
  if (style.glow && positive(style.glow.size, 0) > 0) {
    const g = style.glow
    ctx.save()
    ctx.filter = `blur(${blurPx(g.size / 2)}px)`
    ctx.globalAlpha = baseAlpha * Math.min(1, Math.max(0, finite(g.opacity, 0.8)))
    ctx.strokeStyle = g.color
    ctx.fillStyle = g.color
    ctx.lineWidth = (outer + g.size / 2) * 2
    eachGlyph((gl, x, y) => {
      ctx.strokeText(gl.ch, x, y)
      ctx.fillText(gl.ch, x, y)
    })
    ctx.restore()
    setCanvasFont(ctx, telopFont(style, currentSize))
  }

  // 3. 影(縁取りごと落とす。既定はぼかさない硬い影)
  if (style.shadow) {
    if (shadowBlur > 0) {
      ctx.save()
      ctx.filter = `blur(${blurPx(shadowBlur)}px)`
    }
    ctx.fillStyle = shadowFill
    ctx.strokeStyle = shadowFill
    ctx.lineWidth = outer * 2
    eachGlyph((g, x, y) => {
      if (outer > 0) ctx.strokeText(g.ch, x + sh.dx, y + sh.dy)
      ctx.fillText(g.ch, x + sh.dx, y + sh.dy)
    })
    if (shadowBlur > 0) {
      ctx.restore()
      setCanvasFont(ctx, telopFont(style, currentSize))
    }
  }

  // 4. 縁(外側から)。線は輪郭の両側に半分ずつ乗るので、外へ伸ばしたい量の2倍の幅で引く
  for (const ring of rings) {
    ctx.strokeStyle = ring.gradient
      ? gradientFor(ctx, ring.gradient, {
          x: blockRect.x - ring.reach,
          y: blockRect.y - ring.reach,
          w: blockRect.w + ring.reach * 2,
          h: blockRect.h + ring.reach * 2
        })
      : ring.color
    ctx.lineWidth = ring.reach * 2
    eachGlyph((g, x, y) => ctx.strokeText(g.ch, x, y))
  }

  // 5. 塗り
  const fillGradient: TelopGradient | undefined =
    style.fillGradient ??
    (style.gradientColor
      ? {
          angle: 0,
          stops: [
            { at: 0, color: style.color },
            { at: 1, color: style.gradientColor }
          ]
        }
      : undefined)
  const lineFills = lines.map((_, i) =>
    fillGradient ? gradientFor(ctx, fillGradient, lineRect(i)) : style.color
  )
  eachGlyph((g, x, y, i) => {
    const sung = karaoke && g.word >= 0 && isKaraokeWordSung(karaoke[g.word], timeSeconds)
    if (sung) ctx.fillStyle = style.highlightColor
    else {
      const span = spanStyleOf(style, g)
      ctx.fillStyle = span?.gradient
        ? gradientFor(ctx, span.gradient, { x, y: y - g.size / 2, w: g.width, h: g.size })
        : (span?.color ?? lineFills[i])
    }
    ctx.fillText(g.ch, x, y)
  })

  // 6. 矢印(ブロックの縁から、指した所へ)
  if (style.pointer && ctx.beginPath && positive(style.pointer.width, 0) > 0) {
    drawPointer(ctx, style, blockRect, canvas, rings)
  }
  ctx.restore()
}

/** 矢印を描く。手書き風は少し曲げ、先を2本の線で描く */
function drawPointer(
  ctx: TelopContext,
  style: TextStyle,
  block: { x: number; y: number; w: number; h: number },
  canvas: { w: number; h: number },
  rings: { color: string; reach: number }[]
): void {
  const p = style.pointer!
  const cx = block.x + block.w / 2
  const cy = block.y + block.h / 2
  const tx = cx + finite(p.dx, 0) * canvas.w
  const ty = cy + finite(p.dy, 0) * canvas.h
  const len = Math.hypot(tx - cx, ty - cy)
  if (len < 1) return
  const ux = (tx - cx) / len
  const uy = (ty - cy) / len
  // ブロックの縁から出す(縁と少しの隙間の外)
  const edge =
    Math.min(
      Math.abs(ux) > 1e-6 ? block.w / 2 / Math.abs(ux) : Infinity,
      Math.abs(uy) > 1e-6 ? block.h / 2 / Math.abs(uy) : Infinity
    ) +
    p.width * 2
  if (edge >= len - p.width * 3) return
  const sx = cx + ux * edge
  const sy = cy + uy * edge
  const head = Math.max(p.width * 3, 18)
  const bend = p.hand ? 0.18 : 0
  // 曲げる向き(進む向きに対して左)
  const mx = (sx + tx) / 2 - uy * len * bend * 0.5
  const my = (sy + ty) / 2 + ux * len * bend * 0.5
  const ang = Math.atan2(ty - my, tx - mx)
  const spread = 0.5
  const draw = (color: string, width: number): void => {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.beginPath!()
    ctx.moveTo!(sx, sy)
    if (bend) ctx.quadraticCurveTo!(mx, my, tx, ty)
    else ctx.lineTo!(tx, ty)
    ctx.moveTo!(tx - Math.cos(ang - spread) * head, ty - Math.sin(ang - spread) * head)
    ctx.lineTo!(tx, ty)
    ctx.lineTo!(tx - Math.cos(ang + spread) * head, ty - Math.sin(ang + spread) * head)
    ctx.stroke!()
  }
  // 文字と同じ縁で囲む(どんな画の上でも見えるように)
  for (const ring of rings) draw(ring.color, p.width + ring.reach * 2)
  draw(p.color, p.width)
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

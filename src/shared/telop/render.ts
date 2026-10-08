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
import { NO_LINE_END, NO_LINE_START } from './polish'

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
      | 'createRadialGradient'
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
  /** ルビ(ふりがな)。ルビが掛かる文字の先頭にだけ付け、`rubyLen` 文字ぶんに掛ける */
  ruby?: string
  rubyLen?: number
  /** 本文(書記素に分けた並び)の中の位置。検索・置換で、印を残したまま見えている文字を置き換えるのに使う */
  src?: number
}

/** 単語の途中で折らない文字(空白で区切って書く文字。和文の漢字・かな・全角の記号は文字のあいだで折る) */
function isSpacedWordChar(ch: string): boolean {
  // 長音「ー」・中黒「・」・濁点の記号は文字の種類が「共通」なので、かなと同じく和文として見る。
  // 書記素の先頭の文字で見る(結合文字の付いた「ẹ」や「·」まで和文と見ると、英語などの単語の途中で折れた)
  const head = String.fromCodePoint(ch.codePointAt(0) ?? 0)
  if (
    /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\u3000-\u303f\uff00-\uffef\u30fc\u30fb\u309b\u309c\u30a0]/u.test(
      head
    )
  )
    return false
  // 「㈱」「㍻」「㊤」のような、和文で使う囲み文字・組み文字(文字の種類は「共通」だが、使う文字に
  // 漢字・かなが挙がっている)も和文。英語でも使う「·」(中点)は除く
  if (head !== '\u00b7' && /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u.test(head)) return false
  return /[\p{L}\p{N}\p{P}\p{S}\p{M}]/u.test(ch)
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
      // 行の中に空白があれば、その後ろで折る(単語を割らない)。和文(漢字・かな)以外の文字の単語が
      // 対象(英字だけを見ていたので「Pokémon」「안녕하세요」の途中で折れていた)
      const space = line.map((x) => x.ch).lastIndexOf(' ')
      if (space > 0 && isSpacedWordChar(g.ch)) {
        const rest = line.slice(space + 1)
        lines.push(line.slice(0, space))
        line = rest
        width = rest.reduce((s, x) => s + advance(x.ch, x), 0)
      } else {
        // ルビの掛かった親文字の途中では折らない(折ると、親文字が2行に分かれてルビが出せない)
        let cut = line.length
        for (let k = line.length - 1; k >= 0; k--) {
          const len = line[k].rubyLen ?? 0
          if (line[k].ruby && k + len > line.length) {
            cut = k
            break
          }
        }
        // 禁則: 行頭に「。」「ー」「っ」「」」など、行末に「「」「(」などを置かない。
        // 1文字ずつ前の行から送る(句読点が続いても、数文字まで)
        for (let n = 0; n < 3 && cut > 1; n++) {
          const head = cut < line.length ? line[cut].ch : g.ch
          if (!NO_LINE_START.test(head) && !NO_LINE_END.test(line[cut - 1].ch)) break
          // ルビの掛かった親文字の途中では折らない(親文字ごと次の行へ送る。送れなければ禁則をあきらめる)
          let next = cut - 1
          for (let k = next - 1; k >= 0; k--) {
            const len = line[k].rubyLen ?? 0
            if (line[k].ruby && k + len > next) {
              next = k
              break
            }
          }
          if (next < 1) break
          cut = next
        }
        const rest = cut > 0 ? line.slice(cut) : []
        lines.push(cut > 0 ? line.slice(0, cut) : line)
        line = rest
        width = rest.reduce((s, x) => s + advance(x.ch, x), 0)
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
  const ms = Math.max(0, finite(elapsedSec, 0) * 1000) * telopSpeed(style)
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

/** 動きの速さの倍率(1 が標準) */
export function telopSpeed(style: Pick<TextStyle, 'animationSpeed'>): number {
  const v = style.animationSpeed
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1
}

/** 消える動きの長さ(ms、標準の速さで) */
export const EXIT_ANIMATION_MS = 350
/** 1文字ずつの登場: 1文字の動きの長さと、次の文字が動き出すまでの間(ms、標準の速さで) */
export const CHAR_ANIMATION_MS = 320
export const CHAR_STAGGER_MS = 45

/** ブロック全体の動き(消える動き・ループ)。登場の動き(`telopAnimationAt`)に重ねる */
export interface TelopMotion {
  opacity: number
  scale: number
  dx: number
  dy: number
  /** 回転(度) */
  rotate: number
}

const IDENTITY_MOTION: TelopMotion = { opacity: 1, scale: 1, dx: 0, dy: 0, rotate: 0 }

/**
 * 消える動きとループの、ある時刻の状態。`elapsedSec` は出てから、`remainingSec` は消えるまでの秒。
 * 動きの大きさは文字の大きさに比例させる(大きいテロップほど大きく揺れる)
 */
export function telopMotionAt(
  style: TextStyle,
  elapsedSec: number,
  remainingSec: number,
  canvasHeight: number
): TelopMotion {
  const speed = telopSpeed(style)
  const m = { ...IDENTITY_MOTION }
  const em = positive(style.fontSize, 40)
  const exitMs = EXIT_ANIMATION_MS / speed
  const left = Math.max(0, finite(remainingSec, Infinity) * 1000)
  if (style.exitAnimation && style.exitAnimation !== 'none' && left < exitMs) {
    const p = 1 - left / exitMs // 0 → 1 で消える
    switch (style.exitAnimation) {
      case 'fadeOut':
        m.opacity = 1 - p
        break
      case 'popOut':
        m.opacity = 1 - p
        m.scale = lerp(1, 0.6, p)
        break
      case 'zoomOut':
        m.opacity = 1 - p
        m.scale = lerp(1, 1.6, p)
        break
      case 'slideOutDown':
      case 'slideOutUp': {
        const off = textSlideOffsetPx(canvasHeight)
        m.opacity = 1 - p
        m.dy = (style.exitAnimation === 'slideOutDown' ? 1 : -1) * off * p
        break
      }
    }
  }
  const t = Math.max(0, finite(elapsedSec, 0)) * speed
  switch (style.loopAnimation) {
    case 'shake':
      // 細かく震える(周期の違う正弦を重ねて、規則的に見えないように)
      m.dx += (Math.sin(t * 61) + Math.sin(t * 37) * 0.6) * em * 0.025
      m.dy += (Math.sin(t * 53) + Math.sin(t * 29) * 0.6) * em * 0.025
      break
    case 'pulse':
      m.scale *= 1 + Math.sin(t * Math.PI * 2 * 1.25) * 0.05
      break
    case 'blink':
      m.opacity *= Math.sin(t * Math.PI * 2 * 1.25) >= 0 ? 1 : 0.25
      break
    case 'float':
      m.dy += Math.sin(t * Math.PI * 2 * 0.5) * em * 0.12
      break
    case 'swing':
      m.rotate += Math.sin(t * Math.PI * 2 * 0.6) * 4
      break
  }
  return m
}

/** 1文字ごとの動き(1文字ずつの登場・波打つループ・弧に沿った曲げ)。何もしないなら null */
interface GlyphMotion {
  alpha: number
  scale: number
  dx: number
  dy: number
  /** 回転(ラジアン) */
  rot: number
}

/** 1文字ずつの登場の、i 文字目の状態(出始めからの ms) */
export function charEntranceAt(
  kind: TextStyle['charAnimation'],
  index: number,
  elapsedMs: number,
  speed: number,
  size: number
): GlyphMotion | null {
  if (!kind || kind === 'none') return null
  const local = (Math.max(0, elapsedMs) * speed - index * CHAR_STAGGER_MS) / CHAR_ANIMATION_MS
  if (local >= 1) return null
  const p = Math.max(0, local)
  const ease = 1 - (1 - p) ** 3
  const g: GlyphMotion = { alpha: p <= 0 ? 0 : Math.min(1, p * 2), scale: 1, dx: 0, dy: 0, rot: 0 }
  switch (kind) {
    case 'pop':
      // 少し大きくなってから戻る
      g.scale = p < 0.6 ? lerp(0.2, 1.25, p / 0.6) : lerp(1.25, 1, (p - 0.6) / 0.4)
      break
    case 'drop':
      g.dy = -size * 0.8 * (1 - ease)
      break
    case 'rise':
      g.dy = size * 0.8 * (1 - ease)
      break
    case 'zoom':
      g.scale = lerp(2.4, 1, ease)
      break
    case 'spin':
      g.rot = -Math.PI * (1 - ease)
      g.scale = lerp(0.3, 1, ease)
      break
  }
  return g
}

// ------------------------------------------------------------------ 部分の装飾

/**
 * 本文の `**…**`(強調)・`__…__`(小さく)の印を外した文字列。
 * 書き出しの文字数の確認・一覧の表示など、印を見せたくない所で使う
 */
export function stripTelopMarkup(text: string): string {
  // 描くときと同じ読み方で外す(正規表現で別に外すと、飾りの《》や文字の｜まで消え、描いた文字と食い違う)
  return parseTelopMarkup(text)
    .map((g) => g.ch)
    .join('')
}

/** 本文を書記素に分けた並び(`Glyph.src` が指す並び) */
export function telopSourceUnits(text: string): string[] {
  return graphemes(text ?? '')
}

/** 描く文字とルビの文字をすべて(フォントを先に読み込むのに使う) */
export function telopDrawnChars(text: string): string {
  return parseTelopMarkup(text)
    .map((g) => g.ch + (g.ruby ?? ''))
    .join('')
}

const graphemeSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('ja', { granularity: 'grapheme' })
    : null

/**
 * 文字(書記素)ごとに分ける。絵文字の組み合わせ(👨‍👩‍👧・肌の色・旗)や、濁点を後ろに付けた仮名を
 * 1文字として扱う(コードポイントで分けると、ばらばらに描かれ、途中で折り返される)
 */
function graphemes(text: string): string[] {
  if (!graphemeSegmenter) return [...text]
  const out: string[] = []
  for (const s of graphemeSegmenter.segment(text)) {
    // 印(** __)・改行は1文字ずつ見るので、CRLF などは分けておく
    if (s.segment.length > 1 && /^[\r\n]+$/.test(s.segment)) out.push(...s.segment)
    else out.push(s.segment)
  }
  return out
}

/** 「｜」が無いときにルビとみなす読み(かな・長音・英字だけ。《速報》のような飾りの括弧はルビにしない) */
const RUBY_READING = /^[\p{sc=Hiragana}\p{sc=Katakana}ー・a-zA-Z\s]+$/u

/** ルビの親文字にする文字(「｜」が無いときは、《 の直前に続く漢字) */
const RUBY_BASE = /[\p{sc=Han}々〆ヶ]/u

/**
 * 本文を1文字ずつにし、印の中の文字に `span` を付ける。印そのものは描かない。
 * ルビは青空文庫と同じ書き方: `｜親文字《るび》`、または `漢字《かんじ》`(直前の漢字の並びに掛かる)
 */
export function parseTelopMarkup(text: string): Glyph[] {
  const out: Glyph[] = []
  const chars = graphemes(text ?? '')
  const multiLine = chars.includes('\n')
  let span: 0 | 1 | 2 = 0
  let first = multiLine
  // 「｜」で始めた親文字の先頭(out の位置)
  let rubyStart = -1
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
    if (chars[i] === '｜') {
      // 同じ行の後ろに、閉じた空でない《読み》があるときだけルビの始まり。無ければ文字の「｜」
      const nl = chars.indexOf('\n', i + 1)
      const lineEnd = nl < 0 ? chars.length : nl
      const open = chars.indexOf('《', i + 1)
      const close = open > i ? chars.indexOf('》', open + 1) : -1
      const reopen = open > i ? chars.indexOf('《', open + 1) : -1
      if (
        open > i + 1 &&
        open < lineEnd &&
        close > open + 1 &&
        close < lineEnd &&
        (reopen < 0 || reopen > close)
      ) {
        rubyStart = out.length
        continue
      }
    }
    if (chars[i] === '《') {
      const close = chars.indexOf('》', i + 1)
      const nl = chars.indexOf('\n', i + 1)
      if (close > i && (nl < 0 || close < nl)) {
        const reading = chars.slice(i + 1, close).join('')
        let from = rubyStart
        if (from < 0) {
          from = out.length
          while (from > 0 && RUBY_BASE.test(out[from - 1].ch)) from--
        }
        if (from < out.length && reading && (rubyStart >= 0 || RUBY_READING.test(reading))) {
          out[from] = { ...out[from], ruby: reading, rubyLen: out.length - from }
          rubyStart = -1
          i = close
          continue
        }
      }
    }
    if (chars[i] === '\n') {
      out.push({ ch: '\n', word: -1, src: i })
      first = false
      rubyStart = -1
      continue
    }
    out.push({
      ch: chars[i],
      word: -1,
      src: i,
      ...(span ? { span } : {}),
      ...(first ? { first } : {})
    })
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

/**
 * 置いた1文字。`x` は行(縦書きでは列)の頭からの位置、`cx`/`cy` はブロックの左上を原点にした文字の中心。
 * 縦書きで向きを変える文字は `rot90`、句読点・小さい仮名は `nudge` だけずらす
 */
export interface PlacedGlyph extends Glyph {
  x: number
  size: number
  width: number
  cx: number
  cy: number
  rot90?: boolean
  nudge?: { x: number; y: number }
}

export interface TelopLayout {
  lines: {
    glyphs: PlacedGlyph[]
    /** 行の長さ(縦書きでは列の長さ) */
    width: number
    /** 行の上端(ブロックの上端から)。縦書きでは列の左端(ブロックの左端から) */
    top: number
    /** 行の高さ(縦書きでは列の幅) */
    height: number
    /** 行でいちばん大きい文字の大きさ */
    maxSize: number
    /** 文字が占める矩形(ブロックの左上が原点。背景の帯・グラデーションに使う) */
    rect: { x: number; y: number; w: number; h: number }
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
  vertical: boolean
}

/** 行の高さの倍率 */
function lineHeightOf(style: TextStyle): number {
  const v = style.lineHeight
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : TELOP_LINE_HEIGHT_EM
}

/** 縦書きで 90 度回して置く文字(長音・波線・括弧・矢印・横向きの記号) */
const VERTICAL_ROTATE = /[ー〜～…‥—―\-－=＝()（）「」『』【】［］[\]〈〉《》<>＜＞→←⇒:：;；~]/u
/** 縦書きで右上へ寄せる句読点 */
const VERTICAL_PUNCT = /[、。,，.．]/u
/** 縦書きで少し右上へ寄せる小さい仮名 */
const VERTICAL_SMALL = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/u

/** ルビの大きさ(親文字に対する比) */
export const RUBY_SCALE = 0.45

/**
 * どこに何行で置くか。位置・余白は従来の書き出しと同じ規則:
 * - 上/下寄せは枠の上下から `TEXT_MARGIN_V_RATIO`、左右は `TEXT_MARGIN_H_RATIO` の余白の中で折り返す
 * - 自由配置(`customPosition`)はブロックの中心をその点に置く
 * - 回転・拡大の軸は配置のアンカー(下寄せなら下端中央、上寄せなら上端中央、ほかは中心)
 * 文字の大きさが行の中で違うとき(強調・1行目)は、行の高さはその行のいちばん大きい文字で決める。
 * 縦書きは右の列から左へ並べ、枠の高さ(上下の余白の内側)で折り返す。ルビの分だけ行(列)を広げる
 */
export function layoutTelop(
  ctx: Pick<TelopContext, 'measureText' | 'font'>,
  source: TelopSource,
  canvas: { w: number; h: number }
): TelopLayout {
  // 同じ描く先・同じテロップ(同じ値のオブジェクト)・同じキャンバス・同じ書体の読み込み具合なら、前の配置を使う。
  // 再生中は動くテロップを毎フレーム描き直すが、配置(1文字ずつ幅を測る)が描く時間の約8割だった
  // (実測: 再生6秒で drawTelop 294ms のうち layoutTelop 240ms、measureText 183ms → 覚えると約100ms)。
  // 描く先ごとに分ける(画面・書き出し・QC で測り方が違う)
  const key = `${canvas.w}x${canvas.h}|${layoutEpoch}`
  let perCtx = layoutCache.get(ctx)
  if (!perCtx) {
    perCtx = new WeakMap()
    layoutCache.set(ctx, perCtx)
  }
  const hit = perCtx.get(source)
  if (hit && hit.key === key) {
    setCanvasFont(ctx, telopFont(source.style, positive(source.style.fontSize, 1)))
    return hit.layout
  }
  const layout = measureLayout(ctx, source, canvas)
  perCtx.set(source, { key, layout })
  return layout
}

/**
 * 配置の覚え。テロップの値(`TelopSource`)は書き換えずに差し替える(画面の企画も書き出しの一覧も)ので、
 * オブジェクトごとに覚えれば中身の比較は要らない。消えたテロップ・描く先のぶんは WeakMap なので自然に消える
 */
const layoutCache = new WeakMap<
  object,
  WeakMap<TelopSource, { key: string; layout: TelopLayout }>
>()
let layoutEpoch = 0

/** 書体の読み込みが進んだら呼ぶ(同じ文字でも、測った幅が代わりの書体のものから変わる) */
export function invalidateTelopLayouts(): void {
  layoutEpoch++
}

function measureLayout(
  ctx: Pick<TelopContext, 'measureText' | 'font'>,
  source: TelopSource,
  canvas: { w: number; h: number }
): TelopLayout {
  const style = source.style
  const vertical = style.vertical === true
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
  // 縦書きは1文字が全角の正方形を占める(半角の英数字も縦に積む)
  const advance = vertical
    ? (_ch: string, g: Glyph): number => fontSize * scaleOf(g) + spacing
    : (ch: string, g: Glyph): number => baseAdvance(ch) * scaleOf(g) + spacing
  const karaoke = karaokeWords(source)
  const glyphs: Glyph[] = karaoke
    ? karaoke.flatMap((w, i) => graphemes(w.text).map((ch) => ({ ch, word: i })))
    : parseTelopMarkup(source.text ?? '')
  const marginV = textMarginVPx(canvas.h)
  const availW = Math.max(1, canvas.w - textMarginHPx(canvas.w) * 2)
  const availH = Math.max(1, canvas.h - marginV * 2)
  // 回したテロップは、回した後に枠へ収まる長さで折り返す(回す前の幅で折ると、90度回した
  // 長いテロップが枠の上下へはみ出していた)
  const theta = (finite(style.rotation, 0) * Math.PI) / 180
  const along = Math.abs(Math.cos(theta))
  const across = Math.abs(Math.sin(theta))
  const fit = (main: number, cross: number): number =>
    Math.max(
      1,
      Math.min(along > 1e-9 ? main / along : Infinity, across > 1e-9 ? cross / across : Infinity)
    )
  const maxLength = vertical ? fit(availH, availW) : fit(availW, availH)
  const wrapped = wrapGlyphs(glyphs, maxLength, advance)
  const factor = lineHeightOf(style)
  let top = 0
  const lines = wrapped.map((g) => {
    let x = 0
    const placed: PlacedGlyph[] = g.map((glyph) => {
      const scale = scaleOf(glyph)
      const size = fontSize * scale
      const width = baseAdvance(glyph.ch) * scale
      const out: PlacedGlyph = { ...glyph, x, size, width, cx: 0, cy: 0 }
      x += (vertical ? size : width) + spacing
      return out
    })
    const maxSize = placed.reduce((m, p) => Math.max(m, p.size), placed.length > 0 ? 0 : fontSize)
    const rubySpace = placed.some((p) => p.ruby) ? maxSize * (RUBY_SCALE + 0.1) : 0
    const height = maxSize * factor + rubySpace
    const line = {
      glyphs: placed,
      width: x - (placed.length > 0 ? spacing : 0),
      top,
      height,
      maxSize,
      rubySpace,
      rect: { x: 0, y: 0, w: 0, h: 0 }
    }
    top += height
    return line
  })
  const lineHeight = fontSize * factor
  const longest = lines.reduce((m, l) => Math.max(m, l.width), 0)
  const blockWidth = vertical ? top : longest
  const blockHeight = vertical ? longest : top
  const align = style.align ?? (vertical ? 'left' : 'center')
  for (const l of lines) {
    // 行(列)の頭の位置。縦書きの「左」は上揃え、「右」は下揃え
    const start =
      align === 'left' ? 0 : align === 'right' ? longest - l.width : (longest - l.width) / 2
    const textBand = l.height - l.rubySpace
    if (!vertical) {
      for (const g of l.glyphs) {
        g.cx = start + g.x + g.width / 2
        // 小さい文字は、大きい文字と下をそろえる(行の中心ではなく、ベースラインの近くへ下げる)
        g.cy = l.top + l.rubySpace + textBand / 2 + (l.maxSize - g.size) * 0.38
      }
      l.rect = {
        x: start,
        y: l.top + l.rubySpace + (textBand - l.maxSize) / 2,
        w: l.width,
        h: l.maxSize
      }
    } else {
      // 右の列から左へ。ルビは列の右側
      const left = blockWidth - l.top - l.height
      const centerX = left + textBand / 2
      for (const g of l.glyphs) {
        g.cx = centerX
        g.cy = start + g.x + g.size / 2
        if (VERTICAL_ROTATE.test(g.ch)) g.rot90 = true
        else if (VERTICAL_PUNCT.test(g.ch)) g.nudge = { x: g.size * 0.35, y: -g.size * 0.35 }
        else if (VERTICAL_SMALL.test(g.ch)) g.nudge = { x: g.size * 0.1, y: -g.size * 0.1 }
      }
      l.rect = { x: centerX - l.maxSize / 2, y: start, w: l.maxSize, h: l.width }
    }
  }

  let anchor: { x: number; y: number }
  let topFromAnchor: number
  if (style.customPosition) {
    anchor = {
      x: finite(style.customPosition.x, 0.5) * canvas.w,
      y: finite(style.customPosition.y, 0.5) * canvas.h
    }
    topFromAnchor = -blockHeight / 2
    // 左上・右下などに置く型(16:9 で決めた位置)は、縦長の画面では幅が足りず枠の外へはみ出していた。
    // 背景・縁取りを含めた絵が枠に収まるところまで寄せる(収まらない幅なら真ん中)
    const pad = style.background
      ? telopBackgroundPadding(style, fontSize)
      : { x: telopStrokeRings(style)[0]?.reach ?? 0, y: telopStrokeRings(style)[0]?.reach ?? 0 }
    // 吹き出しの尻尾は箱の外へ出る(下向きの尻尾が枠の下で切れていた)
    const tail = bubbleTailReach(style)
    // 回したテロップは、回した後の外枠で収める(軸はアンカー = ブロックの中心)
    const theta = (finite(style.rotation, 0) * Math.PI) / 180
    const cos = Math.abs(Math.cos(theta))
    const sin = Math.abs(Math.sin(theta))
    const clampAxis = (pos: number, before: number, after: number, size: number): number =>
      before + after >= size ? size / 2 : Math.min(size - after, Math.max(before, pos))
    if (sin < 1e-9) {
      // 回していなければ、尻尾の出る側だけ広く見る
      anchor.x = clampAxis(
        anchor.x,
        blockWidth / 2 + pad.x + tail.left,
        blockWidth / 2 + pad.x + tail.right,
        canvas.w
      )
      anchor.y = clampAxis(
        anchor.y,
        blockHeight / 2 + pad.y + tail.top,
        blockHeight / 2 + pad.y + tail.bottom,
        canvas.h
      )
    } else {
      const w0 = blockWidth / 2 + pad.x + Math.max(tail.left, tail.right)
      const h0 = blockHeight / 2 + pad.y + Math.max(tail.top, tail.bottom)
      const halfW = cos * w0 + sin * h0
      const halfH = sin * w0 + cos * h0
      anchor.x = clampAxis(anchor.x, halfW, halfW, canvas.w)
      anchor.y = clampAxis(anchor.y, halfH, halfH, canvas.h)
    }
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
  return {
    // ルビの分の幅は配置の中だけで使う(外には出さない)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    lines: lines.map(({ rubySpace, ...l }) => l),
    fontSize,
    lineHeight,
    blockWidth,
    blockHeight,
    anchor,
    topFromAnchor,
    vertical
  }
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
/** 吹き出しの尻尾が箱の外へ出る長さ(向きごと、キャンバス px) */
export function bubbleTailReach(style: TextStyle): {
  left: number
  right: number
  top: number
  bottom: number
} {
  const out = { left: 0, right: 0, top: 0, bottom: 0 }
  const tail = style.background && style.backgroundShape === 'bubble' ? style.bubbleTail : undefined
  if (tail) out[tail.side] = Math.max(0, finite(tail.length, 0))
  return out
}

export function telopBackgroundPadding(
  style: TextStyle,
  fontSize: number
): { x: number; y: number } {
  const p = style.backgroundPadding
  return p ? { x: finite(p.x, 0), y: finite(p.y, 0) } : textBoxPaddingPx(fontSize)
}

/** 1文字を動かして描くときの座標の変換(文字の中心へ移し、回し、拡大する) */
interface CellTransform {
  tx: number
  ty: number
  rot: number
  scale: number
}

/** ブロックの座標の点を、文字を動かした後の座標へ写す */
function toLocal(xf: CellTransform | undefined, x: number, y: number): { x: number; y: number } {
  if (!xf) return { x, y }
  const px = x - xf.tx
  const py = y - xf.ty
  const cos = Math.cos(-xf.rot)
  const sin = Math.sin(-xf.rot)
  const s = xf.scale || 1
  return { x: (px * cos - py * sin) / s, y: (px * sin + py * cos) / s }
}

/** 色の止まりを足す。読めない色(壊れた保存データ)で描画ごと落とさない */
function addStops(g: CanvasGradient, gradient: TelopGradient): void {
  for (const s of gradient.stops) {
    try {
      g.addColorStop(Math.min(1, Math.max(0, finite(s.at, 0))), s.color)
    } catch {
      // 読めない色の止まりは飛ばす
    }
  }
}

/**
 * 矩形 `r` に、向き `angle`(0 で上→下、90 で左→右)のグラデーションを掛ける。
 * `xf` は、文字を動かして(移動・回転・拡大)描くときの変換。グラデーションは塗る時の座標で効くので、
 * ブロックの座標で決めた位置を文字の座標へ写して作る(写さないと、揺れる文字だけ色がずれる)
 */
function gradientFor(
  ctx: TelopContext,
  gradient: TelopGradient,
  r: { x: number; y: number; w: number; h: number },
  xf?: CellTransform
): CanvasGradient {
  const scale = xf?.scale || 1
  if (gradient.type === 'radial' && ctx.createRadialGradient) {
    // 中心から外へ。いちばん遠い角まで色が届く半径(CSS の radial-gradient の farthest-corner)
    const c = toLocal(xf, r.x + r.w / 2, r.y + r.h / 2)
    const radius = Math.max(1, Math.hypot(r.w, r.h) / 2) / scale
    const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, radius)
    addStops(g, gradient)
    return g
  }
  const rad = (finite(gradient.angle, 0) * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = Math.cos(rad)
  // CSS の linear-gradient と同じ長さ(角から角まで色が届く)
  const half = Math.abs((r.w / 2) * dx) + Math.abs((r.h / 2) * dy)
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const a = toLocal(xf, cx - dx * half, cy - dy * half)
  const b = toLocal(xf, cx + dx * half, cy + dy * half)
  const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
  addStops(g, gradient)
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
  origin: { x: number; y: number }
): { x: number; y: number; w: number; h: number }[] {
  const pad = telopBackgroundPadding(style, layout.fontSize)
  if ((style.backgroundShape ?? 'lines') === 'lines') {
    return layout.lines
      .filter((l) => l.glyphs.length > 0)
      .map((l) =>
        layout.vertical
          ? {
              x: origin.x + layout.blockWidth - l.top - l.height - pad.x,
              y: origin.y + l.rect.y - pad.y,
              w: l.height + pad.x * 2,
              h: l.width + pad.y * 2
            }
          : {
              x: origin.x + l.rect.x - pad.x,
              y: origin.y + l.top - pad.y,
              w: l.width + pad.x * 2,
              h: l.height + pad.y * 2
            }
      )
  }
  return [
    {
      x: origin.x - pad.x,
      y: origin.y - pad.y,
      w: layout.blockWidth + pad.x * 2,
      h: layout.blockHeight + pad.y * 2
    }
  ]
}

/**
 * テロップが占める矩形(キャンバス px)。プレビューで、つかむための当たり判定に使う。
 * `x`/`y` はアンカーからの差で、回転はアンカーを軸に `rotation` 度(登場アニメは含めない)。
 * 背景があれば余白ぶん、無ければ縁の太さぶん広げる(見えている絵とつかめる範囲を揃える)
 */
export function telopHitBounds(
  ctx: Pick<TelopContext, 'measureText' | 'font'>,
  source: TelopSource,
  canvas: { w: number; h: number }
): { anchor: { x: number; y: number }; x: number; y: number; w: number; h: number } {
  const layout = layoutTelop(ctx, source, canvas)
  const style = source.style
  const pad = style.background
    ? telopBackgroundPadding(style, layout.fontSize)
    : (() => {
        const reach = telopStrokeRings(style)[0]?.reach ?? 0
        return { x: reach, y: reach }
      })()
  // 行の左端はそろえ方によらずブロックの左端(-幅/2)から始まる(`drawTelop` の lineX)。
  // 吹き出しの尻尾も含める(つかめる所・段の高さ)
  const tail = bubbleTailReach(style)
  return {
    anchor: layout.anchor,
    x: -layout.blockWidth / 2 - pad.x - tail.left,
    y: layout.topFromAnchor - pad.y - tail.top,
    w: layout.blockWidth + pad.x * 2 + tail.left + tail.right,
    h: layout.blockHeight + pad.y * 2 + tail.top + tail.bottom
  }
}

/** 影の落とす向きと距離(キャンバス px)。既定は従来と同じ右下へ (o, o) */
function shadowOffset(style: TextStyle): { dx: number; dy: number } {
  if (style.shadowAngle === undefined && style.shadowDistance === undefined)
    return { dx: TEXT_SHADOW_OFFSET_PX, dy: TEXT_SHADOW_OFFSET_PX }
  const dist = finite(style.shadowDistance ?? TEXT_SHADOW_OFFSET_PX * Math.SQRT2, 0)
  const rad = (finite(style.shadowAngle ?? 45, 45) * Math.PI) / 180
  return { dx: Math.cos(rad) * dist, dy: Math.sin(rad) * dist }
}

/** 描く1文字(ブロックの位置へ置いたもの)。`x`/`y` は文字の中心(アンカー基準) */
interface Cell {
  g: { ch: string; word: number; size: number; width: number; span?: 0 | 1 | 2; first?: boolean }
  line: number
  x: number
  y: number
  dx: number
  dy: number
  rot: number
  scale: number
  alpha: number
  ruby: boolean
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
  const elapsed = timeSeconds - source.startTime
  const anim = telopAnimationAt(style, elapsed, canvas.h)
  const motion = telopMotionAt(style, elapsed, source.endTime - timeSeconds, canvas.h)
  const opacity = anim.opacity * motion.opacity
  if (opacity <= 0) return
  const layout = layoutTelop(ctx, source, canvas)
  // 見える文字が無ければ(空・空白・印だけ)、背景の箱・吹き出しも描かない(形によって描いたり
  // 描かなかったりしていた)。矢印だけのテロップは描く
  if (!style.pointer && !layout.lines.some((l) => l.glyphs.some((g) => g.ch.trim() !== ''))) return
  const unit = frame.width / canvas.w
  const fs = layout.fontSize
  const rings = telopStrokeRings(style)
  const karaoke = karaokeWords(source)
  const scale = anim.scale * motion.scale
  const baseAlpha = opacity * Math.min(1, Math.max(0, finite(style.opacity ?? 1, 1)))
  // ぼかしは描く先の画素で効く(拡大縮小の影響を受けない)ので、枠と動きの倍率を掛ける
  const blurPx = (v: number): number => Math.max(0, v * unit * scale)

  ctx.save()
  ctx.scale(unit, unit)
  ctx.translate(layout.anchor.x + motion.dx, layout.anchor.y + anim.offsetY + motion.dy)
  const rotation = finite(style.rotation, 0) + motion.rotate
  if (rotation) ctx.rotate((rotation * Math.PI) / 180)
  if (scale !== 1) ctx.scale(scale, scale)
  ctx.globalAlpha = baseAlpha
  setCanvasFont(ctx, telopFont(style, fs))
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  const origin = { x: -layout.blockWidth / 2, y: layout.topFromAnchor }
  const speed = telopSpeed(style)
  const elapsedMs = elapsed * 1000
  const arcRad = !layout.vertical && style.arc ? (finite(style.arc, 0) * Math.PI) / 180 : 0
  const wave = style.loopAnimation === 'wave'

  // 見えている文字を置く(タイプライター・1文字ずつの登場・弧・波・縦書きの向き)
  const cells: Cell[] = []
  let index = 0
  layout.lines.forEach((l, li) => {
    const lineCenter = l.rect.x + l.rect.w / 2
    const radius = arcRad ? Math.max(1, l.rect.w) / arcRad : 0
    for (const g of l.glyphs) {
      const i = index++
      if (i >= anim.visibleChars) continue
      const m = charEntranceAt(style.charAnimation, i, elapsedMs, speed, g.size)
      if (m && m.alpha <= 0) continue
      let dx = m?.dx ?? 0
      let dy = m?.dy ?? 0
      let rot = m?.rot ?? 0
      if (radius) {
        const u = g.cx - lineCenter
        const theta = u / radius
        dx += radius * Math.sin(theta) - u
        dy += radius * (1 - Math.cos(theta))
        rot += theta
      }
      if (wave) dy += Math.sin(elapsed * speed * Math.PI * 2 * 0.8 - i * 0.55) * g.size * 0.12
      if (g.rot90) rot += Math.PI / 2
      if (g.nudge) {
        dx += g.nudge.x
        dy += g.nudge.y
      }
      cells.push({
        g,
        line: li,
        x: origin.x + g.cx,
        y: origin.y + g.cy,
        dx,
        dy,
        rot,
        scale: m?.scale ?? 1,
        alpha: m?.alpha ?? 1,
        ruby: false
      })
    }
  })

  // ルビ(親文字の上、縦書きでは右に、小さく並べる)
  const rubyCells: Cell[] = []
  cells.forEach((c, k) => {
    const g = c.g as PlacedGlyph
    if (!g.ruby || !g.rubyLen) return
    const base = cells.slice(k, k + g.rubyLen).filter((b) => b.line === c.line)
    if (base.length < g.rubyLen) return // 親文字がまだ全部出ていない(タイプライター)
    const last = base[base.length - 1]
    const rs = g.size * RUBY_SCALE
    const chars = [...g.ruby]
    const alpha = Math.min(...base.map((b) => b.alpha))
    const along = layout.vertical
      ? { from: (c.y + c.dy + last.y + last.dy) / 2, x: c.x + c.dx + g.size / 2 + rs * 0.6 }
      : { from: (c.x + c.dx + last.x + last.dx) / 2, y: c.y + c.dy - g.size / 2 - rs * 0.6 }
    const total = chars.length * rs
    chars.forEach((ch, j) => {
      const pos = along.from - total / 2 + rs * (j + 0.5)
      rubyCells.push({
        g: { ch, word: -1, size: rs, width: ctx.measureText(ch).width * (rs / fs) },
        line: c.line,
        x: layout.vertical ? along.x! : pos,
        y: layout.vertical ? pos : along.y!,
        dx: 0,
        dy: 0,
        rot: 0,
        scale: 1,
        alpha,
        ruby: true
      })
    })
  })
  const all = [...cells, ...rubyCells]

  /** 大きさの違う文字ごとに書体を入れ替える */
  let currentSize = fs
  const switchSize = (size: number): void => {
    if (size === currentSize) return
    currentSize = size
    setCanvasFont(ctx, telopFont(style, size))
  }
  /** 1文字を、その文字の動き(移動・回転・拡大・透明)を付けて描く。`fn` は文字の左端・中心の高さで描く */
  // `off` は文字の向きに関係なくずらす量(影。縦書きで回した文字でも、影は他の文字と同じ向きに落とす)
  /** いま描いている文字の変換(動かさずに描く文字は undefined) */
  let cellXf: CellTransform | undefined
  const put = (c: Cell, fn: (x: number, y: number) => void, off = { x: 0, y: 0 }): void => {
    switchSize(c.g.size)
    if (!c.dx && !c.dy && !c.rot && c.scale === 1 && c.alpha === 1) {
      fn(c.x - c.g.width / 2 + off.x, c.y + off.y)
      return
    }
    ctx.save()
    ctx.translate(c.x + c.dx + off.x, c.y + c.dy + off.y)
    if (c.rot) ctx.rotate(c.rot)
    if (c.scale !== 1) ctx.scale(c.scale, c.scale)
    if (c.alpha !== 1) ctx.globalAlpha = ctx.globalAlpha * c.alpha
    cellXf = { tx: c.x + c.dx + off.x, ty: c.y + c.dy + off.y, rot: c.rot, scale: c.scale }
    try {
      fn(-c.g.width / 2, 0)
    } finally {
      cellXf = undefined
      ctx.restore()
    }
  }
  const eachCell = (
    fn: (c: Cell, x: number, y: number) => void,
    off?: { x: number; y: number }
  ): void => {
    for (const c of all) put(c, (x, y) => fn(c, x, y), off)
    switchSize(fs)
  }

  const lineRect = (i: number): { x: number; y: number; w: number; h: number } => {
    const r = layout.lines[i].rect
    return { x: origin.x + r.x, y: origin.y + r.y, w: Math.max(1, r.w), h: Math.max(1, r.h) }
  }
  const blockRect = {
    x: origin.x,
    y: origin.y,
    w: Math.max(1, layout.blockWidth),
    h: Math.max(1, layout.blockHeight)
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
    const rects = backgroundRects(style, layout, origin)
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
  /** ルビの縁は細く(親文字と同じ太さだと、小さい字がつぶれる) */
  const ringWidth = (c: Cell, reach: number): number => reach * 2 * (c.ruby ? 0.5 : 1)

  // 2. 光彩(縁ごとぼかした色で囲む)
  if (style.glow && positive(style.glow.size, 0) > 0) {
    const g = style.glow
    ctx.save()
    ctx.filter = `blur(${blurPx(g.size / 2)}px)`
    ctx.globalAlpha = baseAlpha * Math.min(1, Math.max(0, finite(g.opacity, 0.8)))
    ctx.strokeStyle = g.color
    ctx.fillStyle = g.color
    eachCell((c, x, y) => {
      ctx.lineWidth = ringWidth(c, outer + g.size / 2)
      ctx.strokeText(c.g.ch, x, y)
      ctx.fillText(c.g.ch, x, y)
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
    eachCell(
      (c, x, y) => {
        ctx.lineWidth = ringWidth(c, outer)
        if (outer > 0) ctx.strokeText(c.g.ch, x, y)
        ctx.fillText(c.g.ch, x, y)
      },
      { x: sh.dx, y: sh.dy }
    )
    if (shadowBlur > 0) {
      ctx.restore()
      setCanvasFont(ctx, telopFont(style, currentSize))
    }
  }

  // 4. 縁(外側から)。線は輪郭の両側に半分ずつ乗るので、外へ伸ばしたい量の2倍の幅で引く
  for (const ring of rings) {
    const ringRect = {
      x: blockRect.x - ring.reach,
      y: blockRect.y - ring.reach,
      w: blockRect.w + ring.reach * 2,
      h: blockRect.h + ring.reach * 2
    }
    const still = ring.gradient ? gradientFor(ctx, ring.gradient, ringRect) : ring.color
    eachCell((c, x, y) => {
      // 動いている文字は、その文字の座標で作り直す
      ctx.strokeStyle =
        ring.gradient && cellXf ? gradientFor(ctx, ring.gradient, ringRect, cellXf) : still
      ctx.lineWidth = ringWidth(c, ring.reach)
      ctx.strokeText(c.g.ch, x, y)
    })
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
  const lineFills = layout.lines.map((_, i) =>
    fillGradient ? gradientFor(ctx, fillGradient, lineRect(i)) : style.color
  )
  eachCell((c, x, y) => {
    const g = c.g
    const sung = karaoke && g.word >= 0 && isKaraokeWordSung(karaoke[g.word], timeSeconds)
    if (sung) ctx.fillStyle = style.highlightColor
    else if (c.ruby) ctx.fillStyle = style.color
    else {
      const span = spanStyleOf(style, g)
      ctx.fillStyle = span?.gradient
        ? gradientFor(ctx, span.gradient, { x, y: y - g.size / 2, w: g.width, h: g.size })
        : (span?.color ??
          (fillGradient && cellXf
            ? gradientFor(ctx, fillGradient, lineRect(c.line), cellXf)
            : lineFills[c.line]))
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
  const style = source.style
  const elapsed = timeSeconds - source.startTime
  const m = telopMotionAt(style, elapsed, source.endTime - timeSeconds, canvasHeight)
  // 1文字ずつの登場の途中・波打つループは、文字ごとの位置が刻々と変わるので時刻ごとに別の絵
  const charsMoving =
    style.loopAnimation === 'wave' ||
    (style.charAnimation &&
      style.charAnimation !== 'none' &&
      elapsed * 1000 * telopSpeed(style) <
        CHAR_ANIMATION_MS + CHAR_STAGGER_MS * [...stripTelopMarkup(source.text)].length)
  const motion = `${m.opacity.toFixed(3)}|${m.scale.toFixed(4)}|${m.dx.toFixed(2)}|${m.dy.toFixed(2)}|${m.rotate.toFixed(3)}`
  return (
    `${a.opacity.toFixed(3)}|${a.scale.toFixed(4)}|${a.offsetY.toFixed(2)}|${chars}|${sung}|${motion}` +
    // 経過時間で区別する(同じ動きのテロップを別の時刻に置いても、同じ絵を使い回せる)
    (charsMoving ? `|t${elapsed.toFixed(4)}` : '')
  )
}

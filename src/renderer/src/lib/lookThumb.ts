import type { TextStyle } from '@shared/types'
import { drawTelop, layoutTelop, type TelopContext } from '@shared/telop/render'
import { stillTelopStyle } from './appearanceEdit'

/**
 * 見た目の小さな見本(見た目の一覧・項目ごとのマイ設定)と、その背景。
 * 書き出しと同じ `drawTelop` で描くので、見本どおりに出る。
 */

/** 見本の仮想キャンバスの基準(本物と同じ 16:9 の 1080) */
const BASE_CANVAS = { w: 1920, h: 1080 }

/** 写真のような落ち着いた背景(空 → 地面)。白い文字・黒い文字どちらも見える明るさ */
export function paintBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#7d97ad')
  g.addColorStop(0.45, '#a9a395')
  g.addColorStop(0.62, '#6f7259')
  g.addColorStop(1, '#3d4236')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, w * 0.7)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(1, 'rgba(0,0,0,0.35)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, w, h)
}

/** これより長い見本は行に分ける(全角の文字数。半角は約半分に数える) */
const THUMB_SPLIT_UNITS = 7
/** 分けたときの1行の長さの目安 */
const THUMB_LINE_UNITS = 9
/** 太字・下線などの印(行を分けると印が壊れるので、印のある行は分けない) */
const MARKUP = /[*_[\]{}~`|<>]/

const NO_LINE_START = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮー、。,.!?！？)）」』…・:：]/
const PARTICLE = /[はがをにでのもとへ]/
const HIRA = /[ぁ-ゖ]/
const KANJI = /[一-龯々]/
const KANJI_KATA = /[一-龯々ァ-ヺ]/
const units = (c: string): number => (/[\x20-\x7e]/.test(c) ? 0.55 : 1)
const isAlnum = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c)

/**
 * 見本の文を、小さな見本でも読める長さの行に分ける。長い1行のまま描くと、枠の横幅に合わせて
 * 縮めるので文字が潰れて読めなかった(発言テロップ・方言の補足・ナレーションなど)。
 * 読点・空白の後ろで分けやすくし、英数字の途中では分けない。縦書き・印のある行はそのまま
 */
export function thumbSampleText(text: string, style: Pick<TextStyle, 'vertical'>): string {
  if (style.vertical) return text
  return text
    .split('\n')
    .map((line) => {
      const chars = [...line]
      const total = chars.reduce((t, c) => t + units(c), 0)
      if (MARKUP.test(line) || total <= THUMB_SPLIT_UNITS) return line
      const n = Math.max(2, Math.min(3, Math.round(total / THUMB_LINE_UNITS)))
      const out: string[] = []
      let from = 0
      for (let k = 1; k < n; k++) {
        const target = (total * k) / n
        let best = -1
        let bestCost = Infinity
        let acc = 0
        for (let i = 0; i < chars.length; i++) {
          acc += units(chars[i])
          const at = i + 1 // chars[at] の前で分ける
          if (at <= from || at >= chars.length) continue
          if (isAlnum(chars[at - 1]) && isAlnum(chars[at])) continue
          // 行の頭に来てはいけない文字(小さい仮名・長音・句読点・閉じ括弧)の前では分けない
          if (NO_LINE_START.test(chars[at])) continue
          const good =
            /[、。,.!?！？\s)）」』]/.test(chars[at - 1]) || /[\s(（「『]/.test(chars[at])
          // 助詞の後ろ(「本当に/おいしい」「中華街の/入り口」)・仮名から漢字への変わり目も分けやすい。
          // 漢字の言葉の途中・送り仮名や仮名の続きの前は分けにくい
          const prev = chars[at - 1]
          const next = chars[at]
          const soft = PARTICLE.test(prev) || (HIRA.test(prev) && KANJI_KATA.test(next))
          const hard =
            KANJI.test(prev) && KANJI.test(next)
              ? 2
              : HIRA.test(next) && !PARTICLE.test(prev)
                ? 1
                : 0
          const cost = Math.abs(acc - target) - (good ? 3 : soft ? 1.5 : 0) + hard
          if (cost < bestCost) {
            bestCost = cost
            best = at
          }
        }
        if (best < 0) break
        out.push(chars.slice(from, best).join('').trim())
        from = best
      }
      out.push(chars.slice(from).join('').trim())
      return out.filter(Boolean).join('\n')
    })
    .join('\n')
}

/**
 * 見本を1枚描く(置き場所は無視して中央に、動きを終えた姿で)。
 * 見た目の一覧のほか、項目ごとのマイ設定の小さな見本にも使う。
 * `fill` は文字の塊が枠のどれだけを占めるまで寄るか。
 */
export function drawLookThumb(
  canvas: HTMLCanvasElement,
  text: string,
  style: TextStyle,
  fill = 0.8,
  maxZoom = 4
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: w, height: h } = canvas
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  paintBackdrop(ctx, w, h)
  ctx.restore()
  const centered: TextStyle = {
    ...stillTelopStyle(style),
    position: 'center',
    customPosition: undefined,
    rotation: 0,
    // 見本は登場の動きを終えた姿で見せる
    animation: 'none',
    charAnimation: undefined,
    exitAnimation: undefined
  }
  // 見本の枠の縦横比に合わせた仮想キャンバス(横長の見本で縦に潰れないように)
  const base = { w: BASE_CANVAS.h * (w / h), h: BASE_CANVAS.h }
  const source = {
    text: thumbSampleText(text, style) || ' ',
    startTime: 0,
    endTime: 1e9,
    style: centered
  }
  // 小さな見本でも読めるよう、文字の塊が枠の 8 割ほどになるまで寄って描く
  // (仮想キャンバスを小さくする = 拡大。塊が収まる大きさなので折り返しは変わらない)
  const layout = layoutTelop(ctx as unknown as TelopContext, source, base)
  const reach =
    (style.outline ? style.outlineWidth : 0) +
    (style.extraStrokes ?? []).reduce((a, s) => a + s.width, 0)
  const bw = layout.blockWidth + reach * 2 + (style.background ? layout.fontSize : 0)
  const bh = layout.blockHeight + reach * 2 + (style.background ? layout.fontSize * 0.6 : 0)
  const zoom = Math.max(
    0.5,
    Math.min(
      maxZoom,
      (base.w * fill) / Math.max(1, bw),
      (base.h * Math.min(0.75, fill)) / Math.max(1, bh)
    )
  )
  drawTelop(
    ctx as unknown as TelopContext,
    source,
    1,
    { width: w, height: h },
    { w: base.w / zoom, h: base.h / zoom }
  )
}

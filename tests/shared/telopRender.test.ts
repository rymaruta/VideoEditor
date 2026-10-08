import { describe, expect, it } from 'vitest'
import { defaultTextStyle } from '@shared/textStyle'
import {
  drawTelop,
  layoutTelop,
  telopAnimationAt,
  telopBackgroundPadding,
  telopHitBounds,
  telopStrokeRings,
  telopVisualKey,
  withAlpha,
  wrapGlyphs,
  type TelopContext,
  type TelopSource
} from '@shared/telop/render'
import { TEXT_MARGIN_V_RATIO } from '@shared/textStyle'
import type { TextStyle } from '@shared/types'
import { NASTY_NUMBERS } from '../helpers/boundary'

/** 1文字 = 文字サイズぶんの幅として測り、呼ばれた描画を記録する偽の Canvas */
interface Call {
  op: string
  args: unknown[]
  fillStyle?: unknown
  strokeStyle?: unknown
  lineWidth?: number
  globalAlpha?: number
}
function fakeContext(): TelopContext & { calls: Call[] } {
  const calls: Call[] = []
  const ctx = {
    calls,
    font: '10px sans-serif',
    fillStyle: '#000' as unknown,
    strokeStyle: '#000' as unknown,
    lineWidth: 1,
    lineJoin: 'miter',
    miterLimit: 10,
    globalAlpha: 1,
    textBaseline: 'alphabetic',
    textAlign: 'start',
    save: () => calls.push({ op: 'save', args: [] }),
    restore: () => calls.push({ op: 'restore', args: [] }),
    translate: (...args: unknown[]) => calls.push({ op: 'translate', args }),
    rotate: (...args: unknown[]) => calls.push({ op: 'rotate', args }),
    scale: (...args: unknown[]) => calls.push({ op: 'scale', args }),
    measureText: (s: string) => {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 10)
      return { width: [...s].length * size } as TextMetrics
    },
    fillText: (...args: unknown[]) =>
      calls.push({ op: 'fillText', args, fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha }),
    strokeText: (...args: unknown[]) =>
      calls.push({
        op: 'strokeText',
        args,
        strokeStyle: ctx.strokeStyle,
        lineWidth: ctx.lineWidth
      }),
    fillRect: (...args: unknown[]) =>
      calls.push({ op: 'fillRect', args, fillStyle: ctx.fillStyle }),
    createLinearGradient: (...args: unknown[]) => {
      const stops: unknown[] = []
      calls.push({ op: 'gradient', args })
      return {
        addColorStop: (...s: unknown[]) => stops.push(s),
        stops,
        args
      } as unknown as CanvasGradient
    }
  }
  return ctx as unknown as TelopContext & { calls: Call[] }
}

const CANVAS = { w: 1920, h: 1080 }
const source = (
  text: string,
  style: Partial<TextStyle> = {},
  extra: Partial<TelopSource> = {}
): TelopSource => ({
  text,
  startTime: 1,
  endTime: 3,
  style: defaultTextStyle({ fontSize: 40, ...style }),
  ...extra
})

describe('wrapGlyphs — 折り返し', () => {
  const g = (s: string): { ch: string; word: number }[] => [...s].map((ch) => ({ ch, word: -1 }))
  const text = (lines: { ch: string }[][]): string[] =>
    lines.map((l) => l.map((x) => x.ch).join(''))

  it('和文は文字のあいだで折る・改行はそのまま区切る', () => {
    expect(text(wrapGlyphs(g('あいうえお'), 3, () => 1))).toEqual(['あいう', 'えお'])
    expect(text(wrapGlyphs(g('あ\nい'), 10, () => 1))).toEqual(['あ', 'い'])
  })

  it('英文は空白のところで折り、単語を割らない', () => {
    expect(text(wrapGlyphs(g('hello world'), 8, () => 1))).toEqual(['hello', 'world'])
  })

  it('英字以外の空白で区切る文字(アクセント付き・ハングル)も単語を割らない', () => {
    expect(text(wrapGlyphs(g('I love Pokémon'), 10, () => 1))).toEqual(['I love', 'Pokémon'])
    expect(text(wrapGlyphs(g('안녕 하세요'), 4, () => 1))).toEqual(['안녕', '하세요'])
  })

  it('禁則: 句点・長音・小書きかな・閉じかっこを行頭に、開きかっこを行末に置かない', () => {
    expect(text(wrapGlyphs(g('あいう。えお'), 3, () => 1))).toEqual(['あい', 'う。え', 'お'])
    expect(text(wrapGlyphs(g('あいゲーム'), 3, () => 1))).toEqual(['あい', 'ゲーム'])
    expect(text(wrapGlyphs(g('あい「うえ」'), 3, () => 1))).toEqual(['あい', '「う', 'え」'])
  })

  it('空・幅0でも落ちない', () => {
    expect(wrapGlyphs([], 10, () => 1)).toEqual([[]])
    expect(text(wrapGlyphs(g('ab'), 0, () => 1))).toEqual(['a', 'b'])
  })
})

describe('layoutTelop — 位置は従来の書き出しと同じ規則', () => {
  it('下寄せはブロックの下端が枠の下から 8% の位置、軸は下端中央', () => {
    const l = layoutTelop(fakeContext(), source('あいう'), CANVAS)
    expect(l.anchor).toEqual({ x: 960, y: 1080 - 1080 * TEXT_MARGIN_V_RATIO })
    expect(l.topFromAnchor).toBe(-l.blockHeight)
    expect(l.blockWidth).toBe(120)
  })

  it('上寄せ・中央・自由配置', () => {
    const ctx = fakeContext()
    expect(layoutTelop(ctx, source('あ', { position: 'top' }), CANVAS).anchor.y).toBeCloseTo(86.4)
    const c = layoutTelop(ctx, source('あ', { position: 'center' }), CANVAS)
    expect(c.anchor).toEqual({ x: 960, y: 540 })
    expect(c.topFromAnchor).toBe(-c.blockHeight / 2)
    const free = layoutTelop(ctx, source('あ', { customPosition: { x: 0.25, y: 0.75 } }), CANVAS)
    expect(free.anchor).toEqual({ x: 480, y: 810 })
  })

  it('左右 5% の余白の内側で折り返す(40px の全角は 1728/40 = 43 文字で1行)', () => {
    const l = layoutTelop(fakeContext(), source('あ'.repeat(50)), CANVAS)
    expect(l.lines.map((x) => x.glyphs.length)).toEqual([43, 7])
  })
})

describe('telopAnimationAt — 長さと動きは ASS の書き出しと同じ', () => {
  const st = (animation: TextStyle['animation']): TextStyle => defaultTextStyle({ animation })
  it('フェードは 300ms で 0→1', () => {
    expect(telopAnimationAt(st('fadeIn'), 0, 1080).opacity).toBe(0)
    expect(telopAnimationAt(st('fadeIn'), 0.15, 1080).opacity).toBeCloseTo(0.5)
    expect(telopAnimationAt(st('fadeIn'), 1, 1080).opacity).toBe(1)
  })
  it('ポップは 60%→100%(200ms)、弾むは 30%→115%→92%→100%', () => {
    expect(telopAnimationAt(st('popIn'), 0, 1080).scale).toBeCloseTo(0.6)
    expect(telopAnimationAt(st('popIn'), 0.2, 1080).scale).toBe(1)
    expect(telopAnimationAt(st('bounce'), 0.25, 1080).scale).toBeCloseTo(1.15)
    expect(telopAnimationAt(st('bounce'), 0.35, 1080).scale).toBeCloseTo(0.92)
    expect(telopAnimationAt(st('bounce'), 0.5, 1080).scale).toBe(1)
  })
  it('下から出るは枠高の 6% 下から 350ms で定位置へ。上からは逆向き', () => {
    expect(telopAnimationAt(st('slideInUp'), 0, 1080).offsetY).toBe(65)
    expect(telopAnimationAt(st('slideInDown'), 0, 1080).offsetY).toBe(-65)
    expect(telopAnimationAt(st('slideInUp'), 0.35, 1080).offsetY).toBe(0)
  })
  it('タイプライターは 40ms ごとに1文字', () => {
    expect(telopAnimationAt(st('typewriter'), 0, 1080).visibleChars).toBe(1)
    expect(telopAnimationAt(st('typewriter'), 0.085, 1080).visibleChars).toBe(3)
    expect(telopAnimationAt(st('none'), 0, 1080).visibleChars).toBe(Infinity)
  })
  it('壊れた経過秒でも有限の値を返す', () => {
    for (const v of NASTY_NUMBERS) {
      const a = telopAnimationAt(st('bounce'), v, 1080)
      expect(
        Number.isFinite(a.opacity) && Number.isFinite(a.scale) && Number.isFinite(a.offsetY)
      ).toBe(true)
    }
  })
})

describe('drawTelop — 描く順と装飾', () => {
  it('出ていない時刻は何も描かない', () => {
    const ctx = fakeContext()
    drawTelop(ctx, source('あ'), 0.5, { width: 1920, height: 1080 }, CANVAS)
    drawTelop(ctx, source('あ'), 3, { width: 1920, height: 1080 }, CANVAS)
    expect(ctx.calls).toEqual([])
  })

  it('縁は外側から順に、輪郭から外へ伸ばす量の2倍の線幅で引き、最後に塗る', () => {
    const ctx = fakeContext()
    const style = {
      outlineColor: '#ff0000',
      outlineWidth: 4,
      extraStrokes: [{ color: '#ffffff', width: 6 }]
    }
    drawTelop(ctx, source('あ', style), 2, { width: 1920, height: 1080 }, CANVAS)
    const strokes = ctx.calls.filter((c) => c.op === 'strokeText')
    expect(strokes.map((c) => [c.strokeStyle, c.lineWidth])).toEqual([
      ['#ffffff', 20],
      ['#ff0000', 8]
    ])
    const ops = ctx.calls.map((c) => c.op).filter((o) => o === 'strokeText' || o === 'fillText')
    expect(ops).toEqual(['strokeText', 'strokeText', 'fillText'])
  })

  it('縦グラデーション: 行の上下に色を置いた塗りで描く', () => {
    const ctx = fakeContext()
    drawTelop(
      ctx,
      source('あ', { gradientColor: '#ffcc00' }),
      2,
      { width: 1920, height: 1080 },
      CANVAS
    )
    expect(ctx.calls.some((c) => c.op === 'gradient')).toBe(true)
    const fill = ctx.calls.find((c) => c.op === 'fillText')!
    expect(typeof fill.fillStyle).toBe('object')
  })

  it('枠の大きさに合わせて全体を拡大縮小する(キャンバスの数字は枠に対する比)', () => {
    const ctx = fakeContext()
    drawTelop(ctx, source('あ'), 2, { width: 480, height: 270 }, CANVAS)
    expect(ctx.calls.find((c) => c.op === 'scale')!.args).toEqual([0.25, 0.25])
  })

  it('背景箱は行ごとに、文字サイズに対する比の余白で塗る', () => {
    const ctx = fakeContext()
    drawTelop(
      ctx,
      source('あい\nう', { background: true, backgroundColor: '#000000', backgroundOpacity: 0.5 }),
      2,
      { width: 1920, height: 1080 },
      CANVAS
    )
    const rects = ctx.calls.filter((c) => c.op === 'fillRect')
    expect(rects).toHaveLength(2)
    expect(rects[0].fillStyle).toBe('rgba(0,0,0,0.5)')
    // 幅 = 文字の幅 + 左右 0.4em
    expect(rects[0].args[2]).toBe(80 + 40 * 0.4 * 2)
  })

  it('カラオケ: 読み終わった単語だけハイライト色で塗る', () => {
    const ctx = fakeContext()
    const s = source(
      'こんにちは',
      { wordHighlight: true, highlightColor: '#ffe600', color: '#ffffff', outline: false },
      {
        words: [
          { text: 'こん', start: 1, end: 1.5 },
          { text: 'にちは', start: 2, end: 2.5 }
        ]
      }
    )
    drawTelop(ctx, s, 1.6, { width: 1920, height: 1080 }, CANVAS)
    const fills = ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.fillStyle)
    expect(fills).toEqual(['#ffe600', '#ffe600', '#ffffff', '#ffffff', '#ffffff'])
  })

  it('カラオケ: 濁点の合成文字・絵文字の連結は1文字として描く(ハイライトの有無で描き方が変わらない)', () => {
    const nfd = 'か\u3099'
    const family = '👨\u200d👩\u200d👧'
    const words = [
      { text: nfd, start: 1, end: 1.5 },
      { text: family, start: 2, end: 2.5 }
    ]
    const count = (wordHighlight: boolean): number => {
      const ctx = fakeContext()
      drawTelop(
        ctx,
        source(nfd + family, { wordHighlight, outline: false }, { words }),
        1.6,
        { width: 1920, height: 1080 },
        CANVAS
      )
      return ctx.calls.filter((c) => c.op === 'fillText').length
    }
    expect(count(true)).toBe(count(false))
    expect(count(true)).toBe(2)
  })

  it('タイプライター: 見えている文字だけ描く', () => {
    const ctx = fakeContext()
    drawTelop(
      ctx,
      source('あいうえ', { animation: 'typewriter', outline: false }),
      1.05,
      { width: 1920, height: 1080 },
      CANVAS
    )
    expect(ctx.calls.filter((c) => c.op === 'fillText')).toHaveLength(2)
  })
})

describe('小物', () => {
  it('telopStrokeRings: 外側から、累計の到達距離で並ぶ。縁取りOFF・幅0は飛ばす', () => {
    expect(
      telopStrokeRings(
        defaultTextStyle({
          outlineWidth: 3,
          extraStrokes: [
            { color: 'a', width: 2 },
            { color: 'b', width: 0 },
            { color: 'c', width: 5 }
          ]
        })
      )
    ).toEqual([
      { color: 'c', reach: 10 },
      { color: 'a', reach: 5 },
      { color: '#000000', reach: 3 }
    ])
    expect(telopStrokeRings(defaultTextStyle({ outline: false }))).toEqual([])
  })

  it('withAlpha', () => {
    expect(withAlpha('#ff8000', 0.25)).toBe('rgba(255,128,0,0.25)')
    expect(withAlpha('red', 0.5)).toBe('red')
    expect(withAlpha('#000000', NaN)).toBe('rgba(0,0,0,1)')
  })

  it('telopVisualKey: 静止したテロップは時刻が変わっても同じ、動いている間は変わる', () => {
    const still = source('あ')
    expect(telopVisualKey(still, 1.5, 1080)).toBe(telopVisualKey(still, 2.9, 1080))
    expect(telopVisualKey(still, 0.5, 1080)).toBe('')
    const pop = source('あ', { animation: 'popIn' })
    expect(telopVisualKey(pop, 1.05, 1080)).not.toBe(telopVisualKey(pop, 1.1, 1080))
    expect(telopVisualKey(pop, 1.5, 1080)).toBe(telopVisualKey(pop, 2.5, 1080))
  })
})

describe('drawTelop — 動く文字のグラデーション', () => {
  /** 塗りに使ったグラデーションの端を、ブロックの座標(文字の移動を足し戻した位置)で返す */
  const fillGradientEnds = (style: Partial<TextStyle>, t: number): number[][] => {
    const ctx = fakeContext()
    drawTelop(ctx, source('AB', style), t, { width: CANVAS.w, height: CANVAS.h }, CANVAS)
    const out: number[][] = []
    // 外側の save(テロップ全体の移動)の内側で、1文字ずつ save → translate したぶんを足し戻す
    let depth = 0
    let shift = { x: 0, y: 0 }
    for (const c of ctx.calls) {
      if (c.op === 'save') depth++
      if (c.op === 'restore' && --depth < 2) shift = { x: 0, y: 0 }
      if (c.op === 'translate' && depth >= 2) shift = { x: Number(c.args[0]), y: Number(c.args[1]) }
      if (c.op === 'fillText' && c.fillStyle && typeof c.fillStyle === 'object') {
        const a = (c.fillStyle as unknown as { args: number[] }).args
        out.push([a[0] + shift.x, a[1] + shift.y, a[2] + shift.x, a[3] + shift.y])
      }
    }
    return out
  }

  it('波打つ文字も、止まった文字と同じ所のグラデーションで塗る', () => {
    const still = fillGradientEnds({ gradientColor: '#ff0000' }, 2)
    const wave = fillGradientEnds({ gradientColor: '#ff0000', loopAnimation: 'wave' }, 2)
    expect(still.length).toBeGreaterThan(0)
    expect(wave.length).toBe(still.length)
    wave.forEach((w, i) => w.forEach((v, k) => expect(v).toBeCloseTo(still[i][k], 3)))
  })

  it('読めない色の止まりがあっても描画を止めない', () => {
    const ctx = fakeContext()
    ;(ctx as unknown as { createLinearGradient: () => unknown }).createLinearGradient = () => ({
      addColorStop: (_at: number, color: string) => {
        if (color === '#ggg') throw new SyntaxError('bad color')
      }
    })
    expect(() =>
      drawTelop(
        ctx,
        source('AB', {
          fillGradient: {
            angle: 0,
            stops: [
              { at: 0, color: '#ggg' },
              { at: 1, color: '#ffffff' }
            ]
          }
        }),
        2,
        { width: CANVAS.w, height: CANVAS.h },
        CANVAS
      )
    ).not.toThrow()
  })
})

describe('第9回: 回転・吹き出しの尻尾・空のテロップ', () => {
  it('90度回した長いテロップは、回した後に枠の上下へはみ出さない長さで折り返す', () => {
    const ctx = fakeContext()
    const src = source('あ'.repeat(40), { rotation: 90, customPosition: { x: 0.5, y: 0.5 } })
    const l = layoutTelop(ctx, src, CANVAS)
    // 回すと幅が縦になる
    expect(l.blockWidth).toBeLessThanOrEqual(1080)
  })

  it('下向きの尻尾の吹き出しを一番下に置いても、尻尾の先まで枠に収める', () => {
    const ctx = fakeContext()
    const src = source('ヒント', {
      background: true,
      backgroundShape: 'bubble',
      bubbleTail: { side: 'bottom', at: 0.5, length: 26 },
      customPosition: { x: 0.5, y: 1 }
    } as Partial<TextStyle>)
    const l = layoutTelop(ctx, src, CANVAS)
    const pad = telopBackgroundPadding(src.style, l.fontSize)
    // 尻尾の先 = 箱の下端 + 尻尾の長さ
    expect(l.anchor.y + l.blockHeight / 2 + pad.y + 26).toBeLessThanOrEqual(1080 + 1e-6)
    // つかめる所(当たり判定)も尻尾を含む
    const b = telopHitBounds(ctx, src, CANVAS)
    expect(b.h).toBeCloseTo(l.blockHeight + pad.y * 2 + 26, 6)
  })

  it('見える文字の無いテロップは、どの形の背景も描かない', () => {
    for (const shape of ['box', 'bubble', 'lines'] as const)
      for (const text of ['', '**', '   ']) {
        const ctx = fakeContext()
        drawTelop(
          ctx,
          source(text, { background: true, backgroundShape: shape } as Partial<TextStyle>),
          1.5,
          { width: 1920, height: 1080 },
          CANVAS
        )
        expect(
          ctx.calls.filter((c) => c.op === 'fillRect' || c.op === 'fillText'),
          `${shape}:${text}`
        ).toEqual([])
      }
  })
})

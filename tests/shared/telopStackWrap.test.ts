import { describe, expect, it } from 'vitest'
import { stackedBottomTelops, stackSimultaneousTelops } from '@shared/telop/stack'
import { telopHitBounds, type TelopContext } from '@shared/telop/render'
import { speechLook } from '@shared/telop/styles'

/** 折り返して2行になった下の段に、上の段を重ねない */
const ctx: Pick<TelopContext, 'measureText' | 'font'> = {
  font: '',
  measureText(ch: string) {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 40)
    return { width: /[\x20-\x7e]/.test(ch) ? size * 0.55 : size } as TextMetrics
  }
}

describe('段に積んだ発言テロップ', () => {
  it('下の段が自動で折り返して2行でも、上の段は下の段に重ならない(9:16・16:9)', () => {
    for (const canvas of [
      { w: 1080, h: 1920 },
      { w: 1920, h: 1080 }
    ]) {
      const style = speechLook('tpl-speech-standard', []).style
      const lower = {
        text: 'ここが中華街の入り口で、今日はここから歩いていきます。まずは名物の肉まんを食べてみましょう',
        startTime: 0,
        endTime: 4,
        style
      }
      const upper = { text: 'そうなんですね', startTime: 1, endTime: 3, style }
      const [a, b] = stackSimultaneousTelops([lower, upper], canvas.h)
      const box = (t: typeof a): { top: number; bottom: number } => {
        const r = telopHitBounds(ctx, t, canvas)
        return { top: r.anchor.y + r.y, bottom: r.anchor.y + r.y + r.h }
      }
      expect(box(b).bottom, `${canvas.w}x${canvas.h}`).toBeLessThanOrEqual(box(a).top + 1e-6)
    }
  })
})

describe('段の見積もり(英字・前に積んだ段)', () => {
  // Electron の太字の幅(文字の大きさに対する比)。大文字は広い
  const real: Pick<TelopContext, 'measureText' | 'font'> = {
    font: '',
    measureText(ch: string) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 40)
      const em = /W/.test(ch)
        ? 0.944
        : /M/.test(ch)
          ? 0.833
          : /[OG]/.test(ch)
            ? 0.778
            : /[A-Z]/.test(ch)
              ? 0.722
              : ch === ' '
                ? 0.278
                : /[\x20-\x7e]/.test(ch)
                  ? 0.556
                  : 1
      return { width: size * em } as TextMetrics
    }
  }
  it('大文字の英語が折り返す下の段にも、上の段を重ねない', () => {
    const canvas = { w: 1080, h: 1920 }
    const style = { ...speechLook('tpl-speech-standard', []).style, fontSize: 64 }
    const lower = { text: 'WOW WHAT A MOVE MAN WOW WOW', startTime: 0, endTime: 3, style }
    const upper = { text: 'すごい', startTime: 1, endTime: 4, style }
    const [a, b] = stackSimultaneousTelops([lower, upper], canvas.h)
    const top = (t: typeof a): number => {
      const r = telopHitBounds(real, t, canvas)
      return r.anchor.y + r.y
    }
    const bottom = (t: typeof a): number => {
      const r = telopHitBounds(real, t, canvas)
      return r.anchor.y + r.y + r.h
    }
    expect(bottom(b)).toBeLessThanOrEqual(top(a) + 1e-6)
  })

  it('前の数え方で積んで保存した段も、段のテロップとして見分ける', () => {
    const style = speechLook('tpl-speech-standard', []).style
    const a = { text: '下の段', startTime: 0, endTime: 4, style }
    const b = { text: '上の段', startTime: 1, endTime: 3, style }
    const old = stackSimultaneousTelops([a, b], 1920, { legacyHeights: true })
    expect(stackedBottomTelops(old, 1920)).toEqual([true, true])
  })
})

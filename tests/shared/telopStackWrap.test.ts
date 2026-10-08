import { describe, expect, it } from 'vitest'
import { stackSimultaneousTelops } from '@shared/telop/stack'
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

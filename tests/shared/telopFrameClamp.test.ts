import { describe, expect, it } from 'vitest'
import { telopHitBounds, type TelopContext } from '@shared/telop/render'
import { TELOP_TEMPLATES } from '@shared/telop/templates'

/** 左上・右上などに置く型を縦長の画面に置いても、絵が枠の外へはみ出さない */
const ctx: Pick<TelopContext, 'measureText' | 'font'> = {
  font: '',
  measureText(ch: string) {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 40)
    return { width: /[\x20-\x7e]/.test(ch) ? size * 0.55 : size } as TextMetrics
  }
}

describe('自由配置のテロップは枠の中', () => {
  it('どの型も、縦長(9:16)・横長(16:9)の枠からはみ出さない(枠より広い文字は真ん中)', () => {
    for (const canvas of [
      { w: 1080, h: 1920 },
      { w: 1920, h: 1080 }
    ]) {
      for (const t of TELOP_TEMPLATES) {
        const style = t.style()
        if (!style.customPosition) continue
        const r = telopHitBounds(ctx, { text: t.sample, style, startTime: 0, endTime: 1 }, canvas)
        if (r.w >= canvas.w) continue
        const left = r.anchor.x + r.x
        expect(left, `${t.id} ${canvas.w}x${canvas.h}`).toBeGreaterThanOrEqual(-1e-6)
        expect(left + r.w, `${t.id} ${canvas.w}x${canvas.h}`).toBeLessThanOrEqual(canvas.w + 1e-6)
      }
    }
  })
})

describe('回したテロップの枠の中への収め方', () => {
  it('回した後の外枠で収める(左端の縦の帯は真ん中へ寄せない・上端に寄せた帯ははみ出さない)', () => {
    const canvas = { w: 1080, h: 1920 }
    const base = TELOP_TEMPLATES[0].style()
    const style = (x: number, y: number): typeof base => ({
      ...base,
      fontSize: 80,
      rotation: 90,
      background: false,
      customPosition: { x, y }
    })
    const left = telopHitBounds(
      ctx,
      { text: 'あいうえおかきくけこさしすせ', style: style(0.08, 0.5), startTime: 0, endTime: 1 },
      canvas
    )
    expect(left.anchor.x).toBeLessThan(200)
    const top = telopHitBounds(
      ctx,
      { text: 'あいうえおかき', style: style(0.5, 0.05), startTime: 0, endTime: 1 },
      canvas
    )
    // 90 度回すと、縦の長さは文字の幅。上端が枠の中
    expect(top.anchor.y - top.w / 2).toBeGreaterThanOrEqual(-1e-6)
  })
})

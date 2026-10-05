import { describe, expect, it } from 'vitest'
import { invalidateTelopLayouts, layoutTelop, type TelopSource } from '@shared/telop/render'
import { defaultTextStyle } from '@shared/textStyle'

/** 幅の測り方を倍率で変えられる偽の描く先(測った回数も数える) */
function ctxOf(scale: number): {
  font: string
  measureText: (s: string) => TextMetrics
  count: number
} {
  const c = {
    font: '10px sans-serif',
    count: 0,
    measureText: (s: string) => {
      c.count++
      return { width: [...s].length * 40 * scale } as TextMetrics
    }
  }
  return c
}

describe('配置の覚え', () => {
  const canvas = { w: 1920, h: 1080 }
  const src: TelopSource = {
    text: 'あいう',
    startTime: 0,
    endTime: 1,
    style: defaultTextStyle({ fontSize: 40 })
  }

  it('同じ描く先・同じテロップなら測り直さない。描く先が違えば別に測る。書体が読み込まれたら測り直す', () => {
    const a = ctxOf(1)
    const b = ctxOf(2)
    const first = layoutTelop(a, src, canvas)
    const measured = a.count
    expect(layoutTelop(a, src, canvas)).toBe(first)
    expect(a.count).toBe(measured)
    expect(layoutTelop(b, src, canvas).blockWidth).toBe(first.blockWidth * 2)
    invalidateTelopLayouts()
    expect(layoutTelop(a, src, canvas)).not.toBe(first)
    // 値を変えたテロップ(別のオブジェクト)は測り直す
    expect(layoutTelop(a, { ...src, text: 'あい' }, canvas).blockWidth).toBe(80)
  })
})

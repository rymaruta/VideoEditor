import { describe, expect, it } from 'vitest'
import { stackSimultaneousTelops } from '../../src/shared/telop/stack'
import { defaultTextStyle } from '../../src/shared/textStyle'

const base = { ...defaultTextStyle(), position: 'bottom' as const, fontSize: 54 }
const t = (
  start: number,
  end: number,
  text = 'えっ？ヤバイ'
): { text: string; startTime: number; endTime: number; style: typeof base } => ({
  text,
  startTime: start,
  endTime: end,
  style: base
})

describe('stackSimultaneousTelops', () => {
  it('同時に出る2枚目を1段上に置き、重ならなければ触らない', () => {
    const out = stackSimultaneousTelops([t(0, 3), t(2, 5), t(6, 8)], 1080)
    expect(out[0].style.customPosition).toBeUndefined()
    expect(out[2].style.customPosition).toBeUndefined()
    const y = out[1].style.customPosition!.y
    // 1段目(下端 92%・高さ 54×1.2=64.8px=6%)の上
    expect(y).toBeLessThan(0.92 - 0.06)
    expect(y).toBeGreaterThan(0.7)
  })

  it('2行のテロップの上には、その分だけ上に積む', () => {
    const one = stackSimultaneousTelops([t(0, 3), t(1, 2)], 1080)[1].style.customPosition!.y
    const two = stackSimultaneousTelops([t(0, 3, '一行目\n二行目'), t(1, 2)], 1080)[1].style
      .customPosition!.y
    expect(two).toBeLessThan(one - 0.05)
  })

  it('手で置いたテロップや、上・中央のテロップには触らない', () => {
    const custom = { ...t(1, 2), style: { ...base, customPosition: { x: 0.2, y: 0.3 } } }
    const top = { ...t(1, 2), style: { ...base, position: 'top' as const } }
    const out = stackSimultaneousTelops([t(0, 3), custom, top], 1080)
    expect(out[1]).toBe(custom)
    expect(out[2]).toBe(top)
  })
})

describe('stackedBottomTelops: 吹き出しの尻尾を段の高さに入れる前に積んだ段', () => {
  it('尻尾を数えずに積んで保存した吹き出しの段も、段のテロップと見分ける', async () => {
    const { stackedBottomTelops } = await import('../../src/shared/telop/stack')
    const bubble = {
      ...base,
      background: true,
      backgroundShape: 'bubble' as const,
      bubbleTail: { side: 'bottom' as const, at: 0.5, length: 24 }
    }
    const telops = [
      { text: 'ヒント', startTime: 0, endTime: 3, style: bubble },
      { text: 'もう一つ', startTime: 1, endTime: 4, style: bubble }
    ]
    // 以前の積み方 = 尻尾の無い同じ吹き出しとして積んだ位置
    const noTail = telops.map((t) => ({ ...t, style: { ...t.style, bubbleTail: undefined } }))
    const saved = stackSimultaneousTelops(noTail, 1080).map((t, i) => ({
      ...t,
      style: { ...t.style, bubbleTail: telops[i].style.bubbleTail }
    }))
    expect(saved[1].style.customPosition).toBeDefined()
    expect(stackedBottomTelops(saved, 1080)).toEqual([true, true])
  })
})

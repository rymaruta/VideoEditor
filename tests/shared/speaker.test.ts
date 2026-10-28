import { describe, expect, it } from 'vitest'
import {
  listSpeakers,
  NO_SPEAKER_COLOR,
  SPEAKER_PALETTE,
  speakerColor
} from '../../src/shared/speaker'

describe('speakerColor', () => {
  it('話者が無ければ無地の色', () => {
    expect(speakerColor(undefined)).toBe(NO_SPEAKER_COLOR)
    expect(speakerColor('  ')).toBe(NO_SPEAKER_COLOR)
  })

  it('同じ名前なら常に同じ色(前後の空白は無視)', () => {
    expect(speakerColor('出演者A')).toBe(speakerColor(' 出演者A '))
    expect(speakerColor('出演者A')).not.toBe(NO_SPEAKER_COLOR)
  })
})

describe('listSpeakers', () => {
  it('多い順・同数は名前順で、空の話者は数えない', () => {
    const overlays = [
      { speaker: 'B' },
      { speaker: 'A' },
      { speaker: 'C' },
      { speaker: 'C' },
      { speaker: '' },
      {}
    ]
    expect(listSpeakers(overlays)).toEqual(['C', 'A', 'B'])
  })
})

describe('話者の色(8 色)', () => {
  const hsl = (hex: string): { h: number; s: number } => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const d = max - min
    const l = (max + min) / 2
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
    let h = 0
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
    }
    return { h: (h * 60 + 360) % 360, s }
  }
  const hueGap = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

  it('8 色で、重ならない', () => {
    expect(SPEAKER_PALETTE).toHaveLength(8)
    expect(new Set(SPEAKER_PALETTE).size).toBe(8)
  })
  it('注意の琥珀・AI の紫・差し色の青・テロップのクリップの色に近い色を使わない', () => {
    for (const reserved of ['#e5b84f', '#a493d9', '#4d8fe6', '#b0588a']) {
      const r = hsl(reserved)
      for (const c of SPEAKER_PALETTE) {
        const x = hsl(c)
        // 色みの薄い色(灰)は色相で取り違えない
        if (x.s < 0.15) continue
        expect(hueGap(x.h, r.h), `${c} と ${reserved}`).toBeGreaterThanOrEqual(15)
      }
    }
  })
})

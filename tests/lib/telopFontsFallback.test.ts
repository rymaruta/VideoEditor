import { describe, expect, it, vi } from 'vitest'
import { defaultTextStyle } from '@shared/textStyle'

/** 書体の並びの2つ目以降(1つ目に無い文字を描く書体)も、描く前に読み込む */
describe('テロップの書体の読み込み', () => {
  it('Kosugi Maru に無い文字のため、続く M PLUS Rounded 1c も読み込む', async () => {
    const loads: string[] = []
    vi.stubGlobal('document', {
      fonts: {
        check: () => false,
        load: async (font: string) => {
          loads.push(font)
          return []
        },
        addEventListener: () => {}
      }
    })
    vi.resetModules()
    const { loadTelopFonts } = await import('@renderer/lib/telopFonts')
    await loadTelopFonts([
      { text: '𠮷野家', style: defaultTextStyle({ fontFamily: 'Kosugi Maru' }) }
    ])
    expect(loads.some((f) => f.includes('"Kosugi Maru"'))).toBe(true)
    expect(loads.some((f) => f.includes('"M PLUS Rounded 1c"'))).toBe(true)
    vi.unstubAllGlobals()
  })
})

import { describe, expect, it } from 'vitest'
import { defaultTextStyle } from '../../src/shared/textStyle'
import {
  buildStyleFile,
  MAX_IMPORT_STYLES,
  parseStyleFile,
  uniqueStyleNames
} from '../../src/renderer/src/lib/telopStyleFile'

describe('テロップスタイルのファイル', () => {
  it('書き出したものを読み込むと同じ見た目に戻る(自由配置は持ち出さない)', () => {
    const style = defaultTextStyle({
      color: '#ff0000',
      fillGradient: {
        angle: 90,
        stops: [
          { at: 0, color: '#ffffff' },
          { at: 1, color: '#000000' }
        ]
      },
      customPosition: { x: 0.2, y: 0.3 }
    })
    const r = parseStyleFile(buildStyleFile([{ name: '赤', style }]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.styles).toHaveLength(1)
    expect(r.styles[0].name).toBe('赤')
    expect(r.styles[0].style.color).toBe('#ff0000')
    expect(r.styles[0].style.fillGradient).toEqual(style.fillGradient)
    expect(r.styles[0].style.customPosition).toBeUndefined()
  })

  it('壊れた JSON・中身の無いファイルは日本語の理由を返す', () => {
    const bad = parseStyleFile('{ not json')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('JSON')
    expect(parseStyleFile('{"version":1,"styles":[]}').ok).toBe(false)
    expect(parseStyleFile('42').ok).toBe(false)
    expect(parseStyleFile('{"version":1,"styles":[1,"a",null]}').ok).toBe(false)
  })

  it('新しい版のファイルは読まない', () => {
    const r = parseStyleFile('{"version":99,"styles":[{"name":"a","style":{}}]}')
    expect(r.ok).toBe(false)
  })

  it('欠けた項目は埋め、壊れた要素は飛ばして数える。配列だけ・1つだけでも読める', () => {
    const r = parseStyleFile(
      JSON.stringify({ version: 1, styles: [{ style: { color: 5, fontSize: 'x' } }, 'junk'] })
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.skipped).toBe(1)
    expect(r.styles[0].name).toBe('読み込んだスタイル 1')
    expect(r.styles[0].style.color).toBe('#ffffff')
    expect(r.styles[0].style.fontSize).toBe(40)
    expect(parseStyleFile('[{"name":"a","style":{}}]').ok).toBe(true)
    expect(parseStyleFile('{"name":"a","style":{}}').ok).toBe(true)
  })

  it('上限より多いスタイルは切り捨てる', () => {
    const many = Array.from({ length: MAX_IMPORT_STYLES + 3 }, () => ({ name: 'a', style: {} }))
    const r = parseStyleFile(JSON.stringify(many))
    expect(r.ok && r.styles.length).toBe(MAX_IMPORT_STYLES)
    expect(r.ok && r.skipped).toBe(3)
  })

  it('名前がかぶったら「名前 (2)」にする(読み込んだもの同士も)', () => {
    const s = defaultTextStyle()
    const out = uniqueStyleNames(
      [{ name: '発言' }, { name: '発言 (2)' }],
      [
        { name: '発言', style: s },
        { name: '発言', style: s },
        { name: '章', style: s }
      ]
    )
    expect(out.map((x) => x.name)).toEqual(['発言 (3)', '発言 (4)', '章'])
  })
})

describe('縦書きのスタイルのファイル', () => {
  it('書き出して読み直しても、縦書きの右端の置き場所は残る(横書きの自由配置は外す)', () => {
    const vertical = defaultTextStyle({ vertical: true, customPosition: { x: 0.9, y: 0.45 } })
    const horizontal = defaultTextStyle({ customPosition: { x: 0.2, y: 0.1 } })
    const r = parseStyleFile(
      buildStyleFile([
        { name: '縦', style: vertical },
        { name: '横', style: horizontal }
      ])
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.styles[0].style.customPosition).toEqual({ x: 0.9, y: 0.45 })
    expect(r.styles[1].style.customPosition).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { buildAssContent } from '@main/assSubtitle'
import { normalizeTextStyle } from '@shared/textStyle'
import type { TextOverlay, TextStyle } from '@shared/types'

const overlay = (style: Partial<TextStyle>): TextOverlay => ({
  id: 'o1',
  text: 'テロップ',
  startTime: 0.5,
  endTime: 2.5,
  style: normalizeTextStyle(style),
  source: 'manual'
})

const dialogues = (ass: string): string[] =>
  ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
const layerOf = (line: string): number => Number(line.slice('Dialogue: '.length).split(',')[0])

describe('buildAssContent — 外側の縁(extraStrokes)', () => {
  it('外側の縁ごとに下の層へ行を重ね、\\bord は縁の太さからの累計になる', () => {
    const ass = buildAssContent(
      [
        overlay({
          outline: true,
          outlineColor: '#000000',
          outlineWidth: 3,
          extraStrokes: [{ color: '#ffffff', width: 5 }]
        })
      ],
      1920,
      1080
    )
    const lines = dialogues(ass)
    expect(lines).toHaveLength(2)
    const [ring, text] = lines
    expect(layerOf(ring)).toBeLessThan(layerOf(text))
    expect(ring).toContain('\\3c&H00FFFFFF\\bord8')
    expect(text).toContain('\\3c&H00000000\\bord3')
    // 同じ文字を同じ所に出す
    expect(ring.endsWith('テロップ')).toBe(true)
    expect(text.endsWith('テロップ')).toBe(true)
  })

  it('2本あれば外側ほど下の層・太い縁。影は一番外の縁だけが落とす', () => {
    const ass = buildAssContent(
      [
        overlay({
          outline: true,
          outlineWidth: 2,
          shadow: true,
          extraStrokes: [
            { color: '#ff0000', width: 4 },
            { color: '#00ff00', width: 3 }
          ]
        })
      ],
      1920,
      1080
    )
    const lines = dialogues(ass)
    expect(lines).toHaveLength(3)
    expect(lines.map(layerOf)).toEqual([0, 1, 2])
    expect(lines[0]).toContain('\\3c&H0000FF00\\bord9')
    expect(lines[0]).toMatch(/\\shad[1-9]/)
    expect(lines[1]).toContain('\\3c&H000000FF\\bord6')
    expect(lines[1]).toContain('\\shad0')
    expect(lines[2]).toContain('\\bord2')
    expect(lines[2]).toContain('\\shad0')
  })

  it('縁が無ければ外側の縁は文字の輪郭から数える', () => {
    const ass = buildAssContent(
      [overlay({ outline: false, extraStrokes: [{ color: '#ffffff', width: 5 }] })],
      1920,
      1080
    )
    const lines = dialogues(ass)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('\\bord5')
    expect(lines[1]).toContain('\\bord0')
  })

  it('帯があれば帯が一番下、その上に外側の縁、一番上に本文', () => {
    const ass = buildAssContent(
      [
        overlay({
          outline: true,
          outlineWidth: 3,
          background: true,
          extraStrokes: [{ color: '#ffffff', width: 5 }]
        })
      ],
      1920,
      1080
    )
    const lines = dialogues(ass)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain(',Boxed,')
    expect(lines.map(layerOf)).toEqual([0, 1, 2])
    expect(lines[1]).toContain('\\bord8')
  })

  it('動き(\\move・\\fad)も縁の行に同じものが付く', () => {
    const ass = buildAssContent(
      [overlay({ animation: 'slideInUp', extraStrokes: [{ color: '#ffffff', width: 5 }] })],
      1920,
      1080
    )
    const [ring, text] = dialogues(ass)
    const moveOf = (l: string): string | undefined => l.match(/\\move\([^)]*\)/)?.[0]
    expect(moveOf(ring)).toBeDefined()
    expect(moveOf(ring)).toBe(moveOf(text))
  })

  it('幅が 0・負・NaN の縁は無視する', () => {
    const ass = buildAssContent(
      [
        overlay({
          extraStrokes: [
            { color: '#ffffff', width: 0 },
            { color: '#ffffff', width: -2 },
            { color: '#ffffff', width: Number.NaN }
          ]
        })
      ],
      1920,
      1080
    )
    expect(dialogues(ass)).toHaveLength(1)
  })

  it('外側の縁が無いテロップは1行のまま(対照)', () => {
    const ass = buildAssContent([overlay({ outline: true, shadow: true })], 1920, 1080)
    const lines = dialogues(ass)
    expect(lines).toHaveLength(1)
    expect(layerOf(lines[0])).toBe(0)
    expect(lines[0]).toMatch(/\\shad[1-9]/)
  })
})

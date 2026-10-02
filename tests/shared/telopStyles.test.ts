import { describe, expect, it } from 'vitest'
import { defaultTextStyle } from '../../src/shared/textStyle'
import {
  countStyleUsage,
  restyleOverlays,
  styleForSpeaker,
  type TelopStyleDef
} from '../../src/shared/telop/styles'
import type { TextOverlay } from '../../src/shared/types'

const base = defaultTextStyle()
const yellow: TelopStyleDef = {
  id: 's1',
  name: '発言・出演者A',
  style: { ...base, color: '#fff4c2' },
  speakers: ['出演者A']
}
const blue: TelopStyleDef = {
  id: 's2',
  name: '発言・出演者B',
  style: { ...base, color: '#2f6fe0' }
}

function overlay(p: Partial<TextOverlay>): TextOverlay {
  return { id: p.id ?? 'o', text: 't', startTime: 0, endTime: 1, style: base, ...p }
}

describe('restyleOverlays', () => {
  it('スタイルを指すテロップは見た目が揃い、自由配置は残る', () => {
    const o = overlay({
      styleId: 's2',
      style: { ...base, customPosition: { x: 0.2, y: 0.3 } }
    })
    const [r] = restyleOverlays([o], [yellow, blue])
    expect(r.style.color).toBe('#2f6fe0')
    expect(r.style.customPosition).toEqual({ x: 0.2, y: 0.3 })
  })

  it('消えたスタイルを指していれば、つながりだけ外して見た目は残す', () => {
    const o = overlay({ styleId: 'gone', style: { ...base, color: '#123456' } })
    const [r] = restyleOverlays([o], [yellow])
    expect(r.styleId).toBeUndefined()
    expect(r.style.color).toBe('#123456')
  })

  it('スタイルの無い発言テロップは、話者に割り当てたスタイルを使う', () => {
    const [a, b] = restyleOverlays(
      [overlay({ id: 'a', speaker: '出演者A' }), overlay({ id: 'b', speaker: '出演者B' })],
      [yellow, blue]
    )
    expect(a.styleId).toBe('s1')
    expect(a.style.color).toBe('#fff4c2')
    expect(b.styleId).toBeUndefined()
  })

  it('スタイル付きのテロップは話者で付け替えない', () => {
    const [r] = restyleOverlays([overlay({ speaker: '出演者A', styleId: 's2' })], [yellow, blue])
    expect(r.styleId).toBe('s2')
  })

  it('変わらなかったテロップは同じオブジェクトのまま', () => {
    const o = overlay({ styleId: 's1', style: yellow.style })
    expect(restyleOverlays([o], [yellow])[0]).toBe(o)
  })
})

describe('styleForSpeaker / countStyleUsage', () => {
  it('話者名の前後の空白は無視する', () => {
    expect(styleForSpeaker([yellow], ' 出演者A ')?.id).toBe('s1')
    expect(styleForSpeaker([yellow], undefined)).toBeNull()
  })

  it('スタイルごとの本数を数える', () => {
    const counts = countStyleUsage([{ styleId: 's1' }, { styleId: 's1' }, {}, { styleId: 's2' }])
    expect(counts.get('s1')).toBe(2)
    expect(counts.get('s2')).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import { defaultTextStyle } from '../../src/shared/textStyle'
import {
  countStyleUsage,
  restyleOverlays,
  restyleSpeechTelops,
  speechLook,
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

describe('発言テロップの見た目(speechLook / restyleSpeechTelops)', () => {
  const mine = { id: 'my', name: 'マイ発言', style: defaultTextStyle({ color: '#ff0000' }) }
  const assigned = {
    id: 'a',
    name: '出演者A用',
    style: defaultTextStyle({ color: '#00ff00' }),
    speakers: ['出演者A']
  }

  it('既定は「発言(白・黒縁)」の型。登録したスタイルを選ぶと styleId でつなぐ', () => {
    const def = speechLook(undefined, [])
    expect(def.styleId).toBeUndefined()
    expect(def.style.outlineWidth).toBeGreaterThanOrEqual(6)
    expect(def.style.fontSize).toBeGreaterThan(defaultTextStyle().fontSize)
    expect(speechLook('my', [mine])).toEqual({ style: mine.style, styleId: 'my' })
    // 消したスタイル・知らない id は既定の型
    expect(speechLook('gone', [mine])).toEqual(def)
    expect(speechLook('tpl-speech-yellow', []).style.color).toBe('#ffe600')
  })

  it('選び直すと、前の見た目のままの自動の発言テロップだけを替える(置き場所は残す)', () => {
    const prev = speechLook(undefined, [])
    const base = {
      startTime: 0,
      endTime: 1,
      source: 'auto' as const,
      utteranceId: 'u'
    }
    const pos = { x: 0.5, y: 0.3 }
    const overlays = [
      { ...base, id: '1', text: 'a', style: { ...prev.style, customPosition: pos } },
      // 手で色を変えた枚
      { ...base, id: '2', text: 'b', style: { ...prev.style, color: '#123456' } },
      // 話者にスタイルを割り当てた枚
      { ...base, id: '3', text: 'c', speaker: '出演者A', style: assigned.style, styleId: 'a' },
      // 手で置いたテロップ
      { ...base, id: '4', text: 'd', source: 'manual' as const, style: prev.style }
    ]
    const next = speechLook('my', [mine, assigned])
    const out = restyleSpeechTelops(overlays, prev, next, [mine, assigned])
    expect(out[0].style.color).toBe('#ff0000')
    expect(out[0].styleId).toBe('my')
    expect(out[0].style.customPosition).toEqual(pos)
    expect(out[1]).toBe(overlays[1])
    expect(out[2]).toBe(overlays[2])
    expect(out[3]).toBe(overlays[3])
    // 登録したスタイルから型へ戻すときは、styleId でつながっている枚を替える
    const back = restyleSpeechTelops(out, next, prev, [mine, assigned])
    expect(back[0].style.color).toBe('#ffffff')
    expect(back[0].styleId).toBeUndefined()
  })
})

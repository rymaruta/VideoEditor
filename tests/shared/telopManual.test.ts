import { describe, expect, it } from 'vitest'
import { defaultTextStyle } from '../../src/shared/textStyle'
import { autoTelopKey, isManualEdit, mergeManualTelops } from '../../src/shared/telop/manual'
import type { TextOverlay } from '../../src/shared/types'

const style = defaultTextStyle()
const auto = (u: string, chunk: number, text: string, start: number): Omit<TextOverlay, 'id'> => ({
  text,
  startTime: start,
  endTime: start + 1,
  style,
  utteranceId: u,
  utteranceChunk: chunk,
  words: [{ text, start, end: start + 1 }]
})

describe('autoTelopKey / isManualEdit', () => {
  it('発言の何枚目か・演出の提案で見分ける。手で置いたものは鍵なし', () => {
    expect(autoTelopKey({ utteranceId: 'u1', utteranceChunk: 2 })).toBe('u:u1#2')
    expect(autoTelopKey({ effectId: 'e1' })).toBe('e:e1')
    expect(autoTelopKey({})).toBeNull()
    expect(isManualEdit({ text: 'x' })).toBe(true)
    expect(isManualEdit({ linkOffset: 1 } as Partial<TextOverlay>)).toBe(false)
  })
})

describe('mergeManualTelops', () => {
  it('人が直した文字と見た目は残し、時刻は新しい仮編集に合わせる。人が消したものは足さない', () => {
    const existing: TextOverlay[] = [
      {
        ...auto('u1', 0, '水をマレーシアから', 3),
        id: 'a',
        text: '水をマレーシアから(直した)',
        style: { ...style, color: '#ff0000' },
        edited: true
      },
      { ...auto('u2', 0, 'そのまま', 6), id: 'b' }
    ]
    const incoming = [
      auto('u1', 0, '水をマレーシアから', 1),
      auto('u2', 0, 'そのまま(新)', 2),
      auto('u3', 0, '消した発言', 4)
    ]
    const r = mergeManualTelops(existing, incoming, new Set(['u:u3#0']))
    expect(r.map((o) => [o.text, o.startTime, o.edited ?? false])).toEqual([
      ['水をマレーシアから(直した)', 1, true],
      // 直していないものは新しい内容のまま
      ['そのまま(新)', 2, false]
    ])
    expect(r[0].style.color).toBe('#ff0000')
    // 文字を直したので、単語ごとの時刻は外す
    expect(r[0].words).toBeUndefined()
  })
})

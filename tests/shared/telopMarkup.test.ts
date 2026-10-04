import { describe, expect, it } from 'vitest'
import {
  parseTelopMarkup,
  stripTelopMarkup,
  telopDrawnChars,
  wrapGlyphs
} from '@shared/telop/render'

describe('部分の装飾とルビの読み方', () => {
  it('ルビ: 直前の漢字に掛かる。「｜」で親文字を決められる', () => {
    const g = parseTelopMarkup('雲丹《うに》と｜浄土ヶ浜《じょうどがはま》')
    expect(g.filter((x) => x.ruby).map((x) => [x.ch, x.ruby, x.rubyLen])).toEqual([
      ['雲', 'うに', 2],
      ['浄', 'じょうどがはま', 4]
    ])
    expect(stripTelopMarkup('雲丹《うに》と｜浄土ヶ浜《じょうどがはま》')).toBe('雲丹と浄土ヶ浜')
    expect(telopDrawnChars('雲丹《うに》')).toBe('雲うに丹')
  })

  it('飾りの括弧《速報》・親文字の無い《》・後ろに《の無い｜は、そのまま文字として出す', () => {
    expect(stripTelopMarkup('大事件《速報》')).toBe('大事件《速報》')
    expect(stripTelopMarkup('《速報》新事実')).toBe('《速報》新事実')
    expect(stripTelopMarkup('A｜B')).toBe('A｜B')
    // 「｜」があれば、読みが漢字でもルビ
    expect(parseTelopMarkup('｜大事件《ニュース》')[0].ruby).toBe('ニュース')
  })

  it('外した文字は、描く文字と同じ(印の組み合わせでも食い違わない)', () => {
    for (const t of ['**a__b**', 'うに丼 **2,800円**', '宮古 __→ 車 →__ 浜', '**閉じない'])
      expect(stripTelopMarkup(t)).toBe(
        parseTelopMarkup(t)
          .map((g) => g.ch)
          .join('')
      )
  })

  it('ルビの掛かった親文字の途中では折り返さない', () => {
    const glyphs = parseTelopMarkup('あいう漢字《かんじ》')
    const lines = wrapGlyphs(glyphs, 4, () => 1)
    expect(lines.map((l) => l.map((g) => g.ch).join(''))).toEqual(['あいう', '漢字'])
  })
})

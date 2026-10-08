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

describe('ルビの記号と、組み合わせた文字', () => {
  it('閉じた空でない《読み》が無い「｜」は、文字としてそのまま出す', () => {
    expect(stripTelopMarkup('｜abc《def')).toBe('｜abc《def')
    expect(stripTelopMarkup('｜漢字《》')).toBe('｜漢字《》')
    const g = parseTelopMarkup('｜ab《c 漢字《かんじ》')
    expect(g.filter((x) => x.ruby).map((x) => [x.ch, x.ruby])).toEqual([['漢', 'かんじ']])
  })

  it('絵文字の組み合わせ・濁点を後ろに付けた仮名は1文字として扱う', () => {
    expect(parseTelopMarkup('👨‍👩‍👧').length).toBe(1)
    expect(parseTelopMarkup('👍🏽🇯🇵').length).toBe(2)
    expect(parseTelopMarkup('か\u3099').map((g) => g.ch)).toEqual(['か\u3099'])
    expect(parseTelopMarkup('**a**\r\nb').map((g) => g.ch)).toEqual(['a', '\r', '\n', 'b'])
  })
})

describe('wrapGlyphs: 禁則とルビ・和文の記号', () => {
  const text = (lines: { ch: string }[][]): string[] =>
    lines.map((l) => l.map((x) => x.ch).join(''))
  it('禁則で送るときも、ルビの親文字の途中では折らない', () => {
    const lines = wrapGlyphs(parseTelopMarkup('あいう東京《とうきょう》。'), 5, () => 1)
    expect(text(lines)).toEqual(['あいう', '東京。'])
    expect(lines[1][0].ruby).toBe('とうきょう')
  })
  it('長音「ー」・中黒「・」は和文として文字のあいだで折る(手前の空白まで戻らない)', () => {
    const g = (s: string): { ch: string; word: number }[] => [...s].map((ch) => ({ ch, word: -1 }))
    expect(text(wrapGlyphs(g('今日は 新しいゲームを買った'), 8, () => 1))).toEqual([
      '今日は 新しい',
      'ゲームを買った'
    ])
  })
})

describe('wrapGlyphs: 英字の単語の中の「·」・結合文字', () => {
  const text = (lines: { ch: string }[][]): string[] =>
    lines.map((l) => l.map((x) => x.ch).join(''))
  it('「col·lecció」「Viẹt」を単語の途中で折らない', () => {
    expect(text(wrapGlyphs(parseTelopMarkup('ab col·lecció'), 6, () => 1))[0]).toBe('ab')
    expect(text(wrapGlyphs(parseTelopMarkup('ab Viẹt Nam'), 5, () => 1))).toEqual([
      'ab',
      'Viẹt',
      'Nam'
    ])
  })
})

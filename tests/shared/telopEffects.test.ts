import { describe, expect, it } from 'vitest'
import { buildEffectPrompt, effectStyle, parseEffectAnswer } from '../../src/shared/telop/effects'

const lines = [
  { id: 'u1', speaker: '出演者A', text: 'えっ？ヤバイですよね', start: 12 },
  { id: 'u2', speaker: '出演者B', text: '浄土ヶ浜まであと3キロ', start: 15 }
]

describe('演出テロップの提案', () => {
  it('話者つきの発言と ID を渡す', () => {
    const p = buildEffectPrompt(lines, '#297', '笑い重視')
    expect(p).toContain('[u1] 0:12 出演者A「えっ？ヤバイですよね」')
    expect(p).toContain('方針: 笑い重視')
  })

  it('正しい提案を受け取り、自信度は 0〜1 に収める', () => {
    const r = parseEffectAnswer(
      {
        effects: [
          {
            after: 'u1',
            kind: 'tsukkomi',
            text: 'いや何が!?',
            confidence: 0.9,
            reason: '驚きへのツッコミ'
          },
          { after: 'u2', kind: 'place', text: '浄土ヶ浜', confidence: 1.4 }
        ]
      },
      lines
    )
    expect(r.map((x) => [x.afterLineId, x.kind, x.text, x.confidence])).toEqual([
      ['u1', 'tsukkomi', 'いや何が!?', 0.9],
      ['u2', 'place', '浄土ヶ浜', 1]
    ])
  })

  it('無い発言・知らない種類・長すぎる文・自信度の無いものは捨てる', () => {
    const r = parseEffectAnswer(
      {
        effects: [
          { after: 'u9', kind: 'tsukkomi', text: 'x', confidence: 0.9 },
          { after: 'u1', kind: 'joke', text: 'x', confidence: 0.9 },
          { after: 'u1', kind: 'kokoro', text: 'あ'.repeat(25), confidence: 0.9 },
          { after: 'u1', kind: 'kokoro', text: '(帰りたい)' },
          null
        ]
      },
      lines
    )
    expect(r).toEqual([])
  })

  it('種類ごとに見た目と置き場所を変える', () => {
    expect(effectStyle('tsukkomi').position).toBe('center')
    expect(effectStyle('place').position).toBe('top')
  })
})

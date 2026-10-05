import { describe, expect, it } from 'vitest'
import {
  buildEffectPrompt,
  effectSchema,
  effectStyle,
  formatEffectText,
  nameProposals,
  parseEffectAnswer
} from '../../src/shared/telop/effects'
import { planSoundEffects } from '../../src/shared/finish/sound'

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

  it('頼み文の例をそのまま写した答え・同じ文の繰り返しは捨てる(発言に本当にある言葉は残す)', () => {
    const r = parseEffectAnswer(
      {
        effects: [
          { after: 'u1', kind: 'tsukkomi', text: 'いや早すぎ！', confidence: 0.5 },
          { after: 'u1', kind: 'kokoro', text: '( 帰りたい… )', confidence: 0.5 },
          { after: 'u1', kind: 'tsukkomi', text: 'いや何が!?', confidence: 0.5 },
          { after: 'u2', kind: 'tsukkomi', text: 'いや何が！？', confidence: 0.5 },
          { after: 'u2', kind: 'place', text: '浄土ヶ浜', confidence: 0.9 },
          { after: 'u1', kind: 'place', text: '浄土ヶ浜', confidence: 0.9 }
        ]
      },
      lines
    )
    expect(r.map((x) => [x.afterLineId, x.text])).toEqual([
      ['u1', 'いや何が!?'],
      ['u2', '浄土ヶ浜']
    ])
  })

  it('強調は発言の中の言葉だけ。注釈は「※」で始める', () => {
    const r = parseEffectAnswer(
      {
        effects: [
          { after: 'u1', kind: 'emphasis', text: 'ヤバイ', confidence: 0.9 },
          { after: 'u1', kind: 'emphasis', text: 'すごい', confidence: 0.9 },
          { after: 'u2', kind: 'note', text: '距離は目安です', confidence: 0.6 },
          { after: 'u2', kind: 'sfx', text: 'シーン…', confidence: 0.5 },
          { after: 'u2', kind: 'name', text: '出演者B', confidence: 1 }
        ]
      },
      lines
    )
    expect(r.map((x) => [x.kind, x.text])).toEqual([
      ['emphasis', 'ヤバイ'],
      ['note', '※距離は目安です'],
      ['sfx', 'シーン…']
    ])
    // AI に頼む種類に人物紹介は入れない
    const schema = JSON.stringify(effectSchema(lines))
    expect(schema).toContain('emphasis')
    expect(schema).not.toContain('"name"')
  })

  it('人物紹介は、名前を付けた出演者の最初の発言に1回だけ(既定の名前には出さない)', () => {
    const r = nameProposals([
      { id: 'a', speaker: '出演者B', text: 'あ', start: 5 },
      { id: 'b', speaker: '山田', text: 'い', start: 1 },
      { id: 'c', speaker: '山田', text: 'う', start: 8 },
      { id: 'd', speaker: 'マイク3', text: 'え', start: 2 },
      { id: 'e', text: 'お', start: 3 }
    ])
    expect(r.map((p) => [p.afterLineId, p.text, p.kind])).toEqual([
      ['b', '山田', 'name'],
      ['a', '出演者B', 'name']
    ])
  })

  it('注釈・人物紹介には SE を付けない', () => {
    const kit = {
      se: { ツッコミ: [{ path: '/se/a.wav', name: 'a', duration: 1 }] },
      bgm: {},
      cg: {}
    }
    const se = planSoundEffects(
      [
        { time: 1, kind: 'note', text: '※' },
        { time: 3, kind: 'name', text: '山田' },
        { time: 5, kind: 'sfx', text: 'ドーン' }
      ],
      [],
      kit
    )
    expect(se.map((x) => x.startTime)).toEqual([5])
  })

  it('種類ごとに見た目と置き場所を変える', () => {
    expect(effectStyle('tsukkomi').position).toBe('center')
    expect(effectStyle('place').position).toBe('top')
    // 人物紹介は左下(発言テロップの下中央と重ねない)、注釈は右下に小さく
    expect(effectStyle('name').customPosition!.x).toBeLessThan(0.5)
    expect(effectStyle('note').fontSize).toBeLessThan(effectStyle('emphasis').fontSize)
  })
})

describe('注のテロップの印', () => {
  it('強調の印「**」で始まる注にも「※」を付ける。「※」「*」で始まる注はそのまま', () => {
    expect(formatEffectText('note', '**撮影時**の価格')).toBe('※**撮影時**の価格')
    expect(formatEffectText('note', '※撮影時の価格')).toBe('※撮影時の価格')
    expect(formatEffectText('note', '*個人の感想です')).toBe('*個人の感想です')
  })
})

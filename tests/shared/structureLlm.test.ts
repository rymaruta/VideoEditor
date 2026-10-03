import { describe, expect, it } from 'vitest'
import {
  buildStructurePrompt,
  chunkScenes,
  parseStructureAnswer
} from '../../src/shared/structure/llm'
import type { Scene } from '../../src/shared/structure/scenes'

const scene = (id: string, start: number, text = 'えっ？ヤバイですよね'): Scene => ({
  id,
  start,
  end: start + 30,
  speech: 20,
  lines: [{ id: `${id}l`, speaker: '出演者A', start, end: start + 3, text, overlap: false }]
})

describe('buildStructurePrompt', () => {
  it('話者つきの文字起こしと、仕上がりの長さを入れる', () => {
    const p = buildStructurePrompt([scene('s1', 0), scene('s2', 30)], 3600, {
      episodeName: '#297',
      targetSec: 1800,
      note: '笑いを優先'
    })
    expect(p).toContain('[s1] 0:00:00〜0:00:30 出演者A「えっ？ヤバイですよね」')
    expect(p).toContain('仕上がり 0:30:00')
    expect(p).toContain('編集方針: 笑いを優先')
  })
})

describe('chunkScenes', () => {
  it('1回に送る数を超えたら分ける', () => {
    const many = Array.from({ length: 95 }, (_, i) => scene(`s${i}`, i * 30))
    const chunks = chunkScenes(many)
    expect(chunks.map((c) => c.length)).toEqual([40, 40, 15])
  })
})

describe('parseStructureAnswer', () => {
  const scenes = [scene('s1', 0), scene('s2', 30)]
  it('正しい答えを受け取り、点数を 0〜100 に収める', () => {
    const r = parseStructureAnswer(
      {
        scenes: [
          {
            id: 's1',
            score: 130,
            kind: 'highlight',
            title: '坂道で絶叫',
            reason: '「ヤバイ」の掛け合い'
          },
          { id: 's2', score: 10, kind: 'unneeded', reason: '移動' }
        ]
      },
      scenes
    )
    expect(r).toEqual([
      {
        sceneId: 's1',
        score: 100,
        kind: 'highlight',
        title: '坂道で絶叫',
        reason: '「ヤバイ」の掛け合い'
      },
      { sceneId: 's2', score: 10, kind: 'unneeded', title: undefined, reason: '移動' }
    ])
  })

  it('頼んでいない ID・知らない種類・数でない点数・壊れた形は捨てる', () => {
    expect(
      parseStructureAnswer(
        {
          scenes: [
            { id: 's9', score: 50, kind: 'normal' },
            { id: 's1', score: 'high', kind: 'normal' },
            { id: 's2', score: 50, kind: 'great' },
            null,
            'x'
          ]
        },
        scenes
      )
    ).toEqual([])
    expect(parseStructureAnswer('nonsense', scenes)).toEqual([])
  })
})

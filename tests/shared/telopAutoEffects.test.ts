import { describe, expect, it } from 'vitest'
import {
  bubbleProposals,
  chapterProposals,
  clockProposals,
  laughProposals
} from '@shared/telop/autoEffects'
import {
  formatEffectText,
  isForeignLine,
  parseEffectAnswer,
  PRICE_MAX_CONFIDENCE,
  type EffectLine
} from '@shared/telop/effects'
import type { Scene, SceneJudgement } from '@shared/structure/scenes'
import type { MulticamInfo } from '@shared/sync/multicam'

const ev = (
  start: number,
  laugh: number
): { start: number; end: number; laugh: number; cheer: number } => ({
  start,
  end: start + 10,
  laugh,
  cheer: 0
})

describe('笑いの添え字', () => {
  it('はっきりした笑いだけ。続いた窓は1回、強ければ「一同爆笑」、近すぎるものは出さない', () => {
    const p = laughProposals([ev(0, 0.05), ev(100, 0.2), ev(105, 0.4), ev(130, 0.5), ev(300, 0.16)])
    expect(p.map((x) => [x.text, x.at])).toEqual([
      ['(一同爆笑)', 110],
      ['(笑)', 305]
    ])
    expect(p[0].confidence).toBeGreaterThan(p[1].confidence)
  })
})

const scene = (id: string, start: number, end: number): Scene => ({
  id,
  start,
  end,
  lines: [],
  speech: 0
})
const judge = (sceneId: string, title?: string): SceneJudgement => ({
  sceneId,
  score: 50,
  kind: 'normal',
  title,
  reason: ''
})

describe('章タイトル', () => {
  it('時間が大きく飛んだ所(移動・次の企画)を章の頭にし、見出しを出す', () => {
    const scenes = [
      scene('a', 0, 100),
      scene('b', 110, 300),
      scene('c', 900, 1000),
      scene('d', 1010, 1200)
    ]
    const p = chapterProposals(
      scenes,
      [judge('a', '島に到着'), judge('b', '港'), judge('c', '水事情'), judge('d', '夕食')],
      ['a', 'b', 'c', 'd']
    )
    expect(p.map((x) => x.text)).toEqual(['第1章\n島に到着', '第2章\n水事情'])
  })

  it('章が1つだけ・見出しが無いなら出さない', () => {
    expect(chapterProposals([scene('a', 0, 100)], [judge('a', 'x')], ['a'])).toEqual([])
    expect(
      chapterProposals(
        [scene('a', 0, 100), scene('b', 900, 1000)],
        [judge('a'), judge('b')],
        ['a', 'b']
      )
    ).toEqual([])
  })
})

describe('時刻', () => {
  it('その時刻を録っている素材の撮影開始から計算し、提案だけにする', () => {
    const info: MulticamInfo = {
      anchorSourceId: 'A',
      sources: [{ id: 'A', name: 'カメラA', kind: 'camera' }],
      files: [{ assetId: 'a1', sourceId: 'A', start: 100, rate: 1, duration: 600 }]
    }
    const start = new Date(2024, 4, 1, 10, 30, 0).getTime()
    const p = clockProposals([220], info, new Map([['a1', start]]))
    expect(p.map((x) => x.text)).toEqual(['AM 10:32'])
    expect(p[0].confidence).toBeLessThan(0.8)
    expect(clockProposals([50], info, new Map([['a1', start]]))).toEqual([])
  })
})

const line = (id: string, text: string): EffectLine => ({ id, text, start: 0 })

describe('吹き出し', () => {
  it('短い驚き・問いかけだけ', () => {
    const p = bubbleProposals([
      line('1', 'えっ ここ?'),
      line('2', 'ここはとても長い発言ですよね?'),
      line('3', 'うまい')
    ])
    expect(p.map((x) => x.afterLineId)).toEqual(['1'])
  })
})

describe('AI の種類ごとの見せ方', () => {
  it('価格は札の形に、ルートは手段を小さく、引きは1行目に「このあと」', () => {
    expect(formatEffectText('price', '海鮮食堂|うに丼|2,800円')).toBe(
      '海鮮食堂\nうに丼 **2,800円**'
    )
    expect(formatEffectText('route', '宮古駅→車で20分→浄土ヶ浜')).toBe(
      '宮古駅 __→ 車で20分 →__ 浄土ヶ浜'
    )
    expect(formatEffectText('teaser', 'このあと まさかの展開に')).toBe('このあと\nまさかの展開に')
    expect(formatEffectText('dialect', 'とってもおいしいね')).toBe('(訳:とってもおいしいね)')
  })

  it('外国語の発言の見分け', () => {
    expect(isForeignLine("It's really delicious!")).toBe(true)
    expect(isForeignLine('これはおいしい')).toBe(false)
    expect(isForeignLine('OK です')).toBe(false)
  })

  it('翻訳は外国語の発言だけ、値段は発言の中の数字だけ。値段は自動では置かない', () => {
    const lines = [
      line('l1', "It's really good"),
      line('l2', 'うに丼は2800円です'),
      line('l3', 'おいしい')
    ]
    const out = parseEffectAnswer(
      {
        effects: [
          { after: 'l1', kind: 'translate', text: '本当においしい', confidence: 0.9, reason: '' },
          { after: 'l3', kind: 'translate', text: 'delicious', confidence: 0.9, reason: '' },
          { after: 'l2', kind: 'price', text: '食堂|うに丼|2,800円', confidence: 0.95, reason: '' },
          { after: 'l2', kind: 'price', text: '食堂|うに丼|3,000円', confidence: 0.95, reason: '' }
        ]
      },
      lines
    )
    expect(out.map((p) => [p.kind, p.afterLineId])).toEqual([
      ['translate', 'l1'],
      ['price', 'l2']
    ])
    expect(out[1].confidence).toBe(PRICE_MAX_CONFIDENCE)
  })
})

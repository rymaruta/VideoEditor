import { describe, expect, it } from 'vitest'
import {
  buildScenes,
  continuesSentence,
  splitInnerTurns,
  type Scene,
  type TimedLine
} from '../../src/shared/structure/scenes'
import { TRIAL4_TRANSCRIPT } from './fixtures/trial4Transcript'

/**
 * 試し編集 第4回(首相官邸の車座対話・先頭 11 分・マイク1本)で残った場面の区切りの不具合。
 * N4: 「あとやはり我々は / 一緒に良いところも…」の間(527.18 秒)で区切り、文の途中から始まる 9 秒の場面が
 *     仕上がりの最後に残って言いかけで終わった
 * N5: 文字起こしが答えの終わりと質問の頭を1件(「…考えております実は千崎社長の日立健貴さんは」)にまとめたため、
 *     区切りが質問の途中(96.34 秒)に入った
 */
const lines = (): TimedLine[] =>
  TRIAL4_TRANSCRIPT.map(([start, end, text], i) => ({
    id: `u${i}`,
    speaker: 'マイク1',
    start,
    end,
    text,
    overlap: false
  }))
const RANGE = { start: 0, end: 660 }
/** 場面の区切り(次の場面の頭) */
const bounds = (scenes: readonly Scene[]): number[] => scenes.slice(1).map((s) => s.start)
const ANSWER_END = '賃上げは大企業とか中小企業問わずにですね経営者の責務としてやることで'
const QUESTION = [
  '実は千崎社長の日立健貴さんは',
  '具体的にどういったですね取り組みをされてその下請けさんから高い評価',
  '得られているのかという話を'
]

describe('N5: 発話の中の質問の頭・長い間で分けてから区切る', () => {
  it('答えの終わりと質問の頭が1件の発話: 言い切りの後の「実は」で、静かな所を見つけて分ける', () => {
    const merged = lines().find((l) => l.text.startsWith(ANSWER_END))!
    // 字数から見積もった所(89.86 秒)の前後 1 秒の中の静かな所(90.3 秒)で分ける
    const asked: [number, number][] = []
    const pieces = splitInnerTurns([merged], (lo, hi) => {
      asked.push([lo, hi])
      return 90.3
    })
    expect(asked).toHaveLength(1)
    expect(asked[0][0]).toBeCloseTo(88.86, 1)
    expect(asked[0][1]).toBeCloseTo(90.86, 1)
    expect(pieces.map((p) => p.text)).toEqual([
      '賃上げは大企業とか中小企業問わずにですね経営者の責務としてやることで誰かから言われてやるという筋合いのものではないと私は基本的に考えております',
      '実は千崎社長の日立健貴さんは'
    ])
    expect(pieces[0].start).toBe(merged.start)
    expect(pieces[0].end).toBe(90.3)
    expect(pieces[1].start).toBe(90.3)
    expect(pieces[1].end).toBe(merged.end)
    expect(pieces[1].id).toBe(`${merged.id}~1`)
  })

  it('語の時刻があれば、0.7 秒以上の間と、質問の頭の語の頭で分ける', () => {
    const l: TimedLine = {
      id: 'x',
      start: 10,
      end: 16,
      text: 'そうですね頑張りました田中さん、どうですか',
      overlap: false,
      words: [
        { text: 'そうですね', start: 10, end: 11 },
        { text: '頑張りました', start: 11.9, end: 13 },
        { text: '田中さん、', start: 13.2, end: 14 },
        { text: 'どうですか', start: 14.1, end: 16 }
      ]
    }
    const pieces = splitInnerTurns([l])
    expect(pieces.map((p) => [p.text, p.start, p.end])).toEqual([
      ['そうですね', 10, 11],
      ['頑張りました', 11.9, 13],
      ['田中さん、どうですか', 13.2, 16]
    ])
    // 言い切りが無い・切れ端が短い所では分けない
    expect(splitInnerTurns([{ ...l, words: undefined, text: '実はでは' }])).toHaveLength(1)
    expect(
      splitInnerTurns([{ ...l, words: undefined, text: '今日はいい天気ですね' }])
    ).toHaveLength(1)
  })

  it('第4回の実文: 質問(「実は千崎社長の…」〜「…得られているのかという話を」)の途中で区切らない', () => {
    const scenes = buildScenes(lines(), RANGE)
    const q = QUESTION.map(
      (text) => scenes.find((s) => s.lines.some((l) => l.text.includes(text)))!.id
    )
    expect(new Set(q).size).toBe(1)
    // 区切りは質問の途中(前は 96.34 秒)に入らない。音が無ければ質問の頭を含む発話(76.24〜92.55 秒)の
    // 内側にも置かない(声の途中になりうる)
    for (const b of bounds(scenes)) expect(b > 76.24 && b < 106.53).toBe(false)
    // 場面の発話の文はつなぐと元の文(分けても文は欠けない)
    const all = scenes.flatMap((s) => s.lines.map((l) => l.text)).join('')
    expect(all).toBe(
      lines()
        .map((l) => l.text)
        .join('')
    )
    // 場面に語の時刻は残さない
    expect(scenes.every((s) => s.lines.every((l) => l.words === undefined))).toBe(true)
  })
})

describe('N4: 区切りを文の境に寄せ、言いかけの短い場面を最後に残さない', () => {
  it('第4回の実文: 続きのある形で終わる発話の後の間(527.18 秒)では区切らない', () => {
    const scenes = buildScenes(lines(), RANGE)
    for (const b of bounds(scenes)) expect(Math.abs(b - 527.18)).toBeGreaterThan(1)
    const sceneOf = (text: string): string =>
      scenes.find((s) => s.lines.some((l) => l.text === text))!.id
    expect(sceneOf('一緒に良いところも悪いところも頑張っていこうという形で')).toBe(
      sceneOf('あとやはり我々は')
    )
    // 区切りの前の発話が続きのある形で終わる所は、長い無言(8 秒)か、長さの上限で分けた所だけ
    for (let i = 1; i < scenes.length; i++) {
      const prev = scenes[i - 1].lines.at(-1)
      const head = scenes[i].lines[0]
      if (!prev || !head || !continuesSentence(prev.text)) continue
      const long = prev.end - scenes[i - 1].lines[0].start >= 90
      expect(head.start - prev.end >= 8 || long).toBe(true)
    }
  })
})

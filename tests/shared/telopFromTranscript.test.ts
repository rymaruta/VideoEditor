import { describe, expect, it } from 'vitest'
import {
  tidyTelopText,
  utteranceToTelopChunks,
  wrapTelopLines
} from '../../src/shared/telop/fromTranscript'
import { utteranceTimelineRange, isLikelyHallucination } from '../../src/shared/transcript'

describe('tidyTelopText', () => {
  it('文末の句点を落とし、読点は空白にする(言葉は変えない)', () => {
    expect(tidyTelopText('木曜日、停戦会談は終了しました。')).toBe('木曜日 停戦会談は終了しました')
    expect(tidyTelopText('えっ？ヤバイですよね!')).toBe('えっ？ヤバイですよね!')
  })
})

describe('wrapTelopLines', () => {
  it('行の後ろ半分に句読点があれば、その後で改行する', () => {
    expect(wrapTelopLines('あいうえおかきくけこ、さしすせそ', 14)).toEqual([
      'あいうえおかきくけこ、',
      'さしすせそ'
    ])
  })

  it('行の長さを揃え、その近くの良い区切り(助詞の後)で改行する', () => {
    expect(wrapTelopLines('木曜日、停戦会談は何の進展もないまま終了', 14)).toEqual([
      '木曜日、停戦会談は何の',
      '進展もないまま終了'
    ])
  })

  it('長い発話の最後の1枚が数文字だけにならず、どの1枚も2行に収まる(1行18字でも)', () => {
    const text = '森永の美味しい牛乳は濃い青色に牛乳瓶をあしらったデザインのパック牛乳である'
    for (const maxLineChars of [14, 18]) {
      const chunks = utteranceToTelopChunks(
        { text, words: [{ text, start: 0, end: 5 }], sourceStart: 0, sourceEnd: 5 },
        { maxLineChars }
      )
      for (const c of chunks) {
        const lines = c.text.split('\n')
        expect(lines.length).toBeLessThanOrEqual(2)
        for (const l of lines) expect([...l].length).toBeLessThanOrEqual(maxLineChars)
        expect([...c.text.replace(/\s/g, '')].length).toBeGreaterThan(6)
      }
      expect(chunks.map((c) => c.text.replace(/\n/g, '')).join('')).toBe(text)
    }
  })
})

describe('utteranceToTelopChunks', () => {
  it('長い発話は2行×14文字に収まるよう分け、時刻は言葉の時刻から取る', () => {
    const words = [
      { text: '木曜日、', start: 10, end: 10.8 },
      { text: '停戦会談は何の進展もないまま終了しました。', start: 10.8, end: 14 },
      { text: 'そして次の会談の日程も決まらないまま、関係者は帰国しました。', start: 14.5, end: 19 }
    ]
    const chunks = utteranceToTelopChunks({ text: '', words, sourceStart: 10, sourceEnd: 19 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const c of chunks) {
      const lines = c.text.split('\n')
      expect(lines.length).toBeLessThanOrEqual(2)
      expect(lines.every((l) => [...l].length <= 14)).toBe(true)
    }
    expect(chunks[0].sourceStart).toBe(10)
    expect(chunks.at(-1)!.sourceEnd).toBeCloseTo(19, 5)
    // 言葉は落とさない(句読点と空白を除いて元と同じ)
    const strip = (s: string): string => s.replace(/[\s、。\n]/g, '')
    expect(strip(chunks.map((c) => c.text).join(''))).toBe(strip(words.map((w) => w.text).join('')))
  })

  it('短い発話でも最低 1 秒は出す', () => {
    const [c] = utteranceToTelopChunks({
      text: 'えっ',
      words: [{ text: 'えっ', start: 5, end: 5.3 }],
      sourceStart: 5,
      sourceEnd: 5.3
    })
    expect(c.sourceEnd - c.sourceStart).toBeCloseTo(1, 5)
  })
})

describe('utteranceTimelineRange', () => {
  it('その素材を使っているクリップから、タイムラインの位置を割り出す', () => {
    const clips = [
      { assetId: 'M', startTime: 0, inPoint: 10, outPoint: 310 },
      { assetId: 'M', startTime: 300, inPoint: 400, outPoint: 700, speed: 1.0001 }
    ]
    expect(utteranceTimelineRange({ assetId: 'M', sourceStart: 20, sourceEnd: 22 }, clips)).toEqual(
      {
        start: 10,
        end: 12
      }
    )
    const r = utteranceTimelineRange({ assetId: 'M', sourceStart: 500, sourceEnd: 501 }, clips)!
    expect(r.start).toBeCloseTo(300 + 100 / 1.0001, 9)
    // カットで落とした部分(310〜400)の発話は出さない
    expect(
      utteranceTimelineRange({ assetId: 'M', sourceStart: 350, sourceEnd: 351 }, clips)
    ).toBeNull()
  })
})

describe('isLikelyHallucination', () => {
  it('無音で出がちな決まり文句を見分ける', () => {
    expect(isLikelyHallucination('ご視聴ありがとうございました')).toBe(true)
    expect(isLikelyHallucination('ありがとうございました')).toBe(false)
  })
})

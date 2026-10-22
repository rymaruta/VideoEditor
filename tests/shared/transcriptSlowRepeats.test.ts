import { describe, expect, it } from 'vitest'
import {
  fitSegmentsToRange,
  hallucinatedIndices,
  isLikelyHallucination,
  isStockHallucination,
  type TimedText
} from '../../src/shared/transcript'

/**
 * 作り話の除去(遅すぎる繰り返し)が、ゆっくり言った本当の繰り返しを消していた。
 * - 終わりの分からない区切り(区間の終わりまで伸ばしたもの)の「はい、はい、はい」「そうそうそう」
 * - 間を空けた「はい。はい。はい。」・発話をまたいだ相づち「うん」3つ・数える「1、1、1、1、1」・歌の「ラララ」
 * 典型的な作り話(「2分間」×4 以上・「んんん…」・同じ英文の 13 回・長さ 0 の区切り)は引き続き捨てる
 */

/** 文字を言葉に分け、区間に隙間なく並べる(認識が言葉の時刻を引き伸ばしたとき) */
function timed(text: string, start: number, end: number, pieces = 1): TimedText {
  const chars = [...text]
  const per = Math.ceil(chars.length / pieces)
  const words: { text: string; start: number; end: number }[] = []
  for (let i = 0; i < chars.length; i += per)
    words.push({ text: chars.slice(i, i + per).join(''), start: 0, end: 0 })
  const step = (end - start) / words.length
  words.forEach((w, i) => {
    w.start = start + step * i
    w.end = start + step * (i + 1)
  })
  return { text, start, end, words }
}

const kept = (items: TimedText[]): string[] => {
  const drop = hallucinatedIndices(items)
  return items.filter((_, i) => !drop.has(i)).map((x) => x.text)
}

describe('ゆっくり言った本当の繰り返しを残す', () => {
  it('終わりの分からない区切り(区間の終わりまで伸ばした)の「はい、はい、はい」「そうそうそう」', () => {
    for (const text of ['はい、はい、はい', 'そうそうそう']) {
      const seg = { text, start: 6, end: 12, endUnknown: true }
      expect(fitSegmentsToRange([seg], 0, 12).map((s) => s.text)).toEqual([text])
    }
    // 返事以外の言葉でも、推し量った長さ(区間の終わりまで 24 秒)は遅さに使わない
    const long = {
      text: 'なるほど、なるほど、なるほど、なるほど',
      start: 6,
      end: 30,
      endUnknown: true
    }
    expect(fitSegmentsToRange([long], 0, 30).map((s) => s.text)).toEqual([long.text])
    // 終わりが分かっていて、本当に 24 秒かけた 4 回なら作り話として捨てる
    expect(fitSegmentsToRange([{ ...long, endUnknown: false }], 0, 30)).toEqual([])
  })

  it('言葉の時刻のある、ゆっくりした繰り返し', () => {
    const cases: TimedText[][] = [
      // 間を空けた「はい。はい。はい。」(4.5 秒の1区切り。言葉の時刻が引き伸ばされている)
      [timed('はい。はい。はい。', 0, 4.5, 3)],
      // 1.5 秒ずつ・間 0.5 秒の「うん」3つ(発話をまたぐ)
      [timed('うん', 10, 11.5), timed('うん', 12, 13.5), timed('うん', 14, 15.5)],
      // 数える「1、1、1、1、1」(5 秒)
      [timed('1、1、1、1、1', 20, 25, 5)],
      // 歌の「ラララ ラララ」(6 秒)
      [timed('ラララ ラララ', 30, 36, 2)]
    ]
    for (const items of cases) expect(kept(items)).toEqual(items.map((x) => x.text))
  })
})

describe('典型的な作り話は引き続き捨てる', () => {
  it('遅すぎる繰り返し(「2分間」×4・5、「んんん…」・「ヌー」×5)', () => {
    expect(kept([timed('2分間2分間2分間2分間', 45.16, 54.91, 4)])).toEqual([])
    expect(
      kept([timed('2分間', 40.96, 44.98), timed('2分間2分間2分間2分間', 45.16, 54.91, 4)])
    ).toEqual([])
    expect(kept([timed('んんんんんんんんんんん', 128.35, 150.34)])).toEqual([])
    expect(kept([timed('アバー!カッ!ヌー!ヌー!ヌー!ヌー!ヌー!', 74.25, 93.75, 7)])).toEqual([])
  })

  it('同じ英文の 13 回と、長さ 0 の区切り', () => {
    const words = Array.from({ length: 13 }, () => "I'm going to get the car.".split(' ')).flat()
    const segs: {
      start: number
      end: number
      text: string
      words: { start: number; end: number; text: string }[]
    }[] = []
    for (let i = 0; i < words.length; i += 5) {
      const wl = words.slice(i, i + 5).map((w, k) => ({
        text: (k ? ' ' : '') + w,
        start: 160 + i * 0.5 + k * 0.5,
        end: 160 + i * 0.5 + k * 0.5 + 0.4
      }))
      segs.push({
        text: wl.map((w) => w.text).join(''),
        start: wl[0].start,
        end: wl[wl.length - 1].end,
        words: wl
      })
    }
    const zero = {
      text: 'Okay.',
      start: 163.54,
      end: 163.54,
      words: [{ text: 'Okay.', start: 163.54, end: 163.54 }]
    }
    expect(fitSegmentsToRange([...segs, zero], 160, 200, () => false)).toEqual([])
  })
})

describe('よく言う返事は、単位をずらしても(「いは」「はいはい」)返事として残す', () => {
  it('ゆっくり言った「はい。」×5・「うん。」×5(7.5 秒)・「そうそう」×4', () => {
    const cases: TimedText[][] = [
      [timed('はい。はい。はい。はい。はい。', 0, 7.5, 5)],
      [timed('うん。うん。うん。うん。うん。', 10, 17.5, 5)],
      [timed('はいはい。はいはい。はいはい。はいはい。', 20, 32, 4)],
      [timed('そうそう、そうそう、そうそう、そうそう', 40, 52, 4)]
    ]
    for (const items of cases) expect(kept(items)).toEqual(items.map((x) => x.text))
  })

  it('1.5 秒の「うん」5つ(間 0.5 秒)は、途中だけ消さずに全部残す', () => {
    const items = Array.from({ length: 5 }, (_, k) => timed('うん', 60 + k * 2, 61.5 + k * 2))
    expect(kept(items)).toEqual(items.map((x) => x.text))
  })

  it('返事でない言葉の遅すぎる繰り返しは、ずらした単位でも引き続き捨てる', () => {
    expect(kept([timed('2分間2分間2分間2分間2分間', 0, 12, 5)])).toEqual([])
    const items = Array.from({ length: 5 }, (_, k) => timed('2分間', 20 + k * 3, 22.5 + k * 3))
    expect(kept(items)).toEqual([])
  })
})

describe('決まり文句の繰り返し・とても遅い「ん」', () => {
  it('「ご視聴ありがとうございました。」×3(30 秒に引き伸ばし)は決まり文句として捨てる', () => {
    const text = 'ご視聴ありがとうございました。'.repeat(3)
    const t = timed(text, 0, 30, 3)
    const stock = { ...t, words: (t.words ?? []).map((w) => ({ ...w, text: w.text ?? '' })) }
    expect(isStockHallucination(text)).toBe(true)
    expect(isLikelyHallucination(text)).toBe(true)
    expect(isLikelyHallucination('ご視聴ありがとうございました ご視聴ありがとうございました')).toBe(
      true
    )
    expect(fitSegmentsToRange([stock], 0, 30)).toEqual([])
    expect(fitSegmentsToRange([stock], 0, 30, () => true)).toEqual([])
    // 決まり文句と同じく、音が鳴っている所のものは本当の言葉として残す
    expect(fitSegmentsToRange([stock], 0, 30, () => false)).toHaveLength(1)
    // 決まり文句を含むだけの文は当たらない
    expect(isLikelyHallucination('ご視聴ありがとうございました。また来週お会いしましょう')).toBe(
      false
    )
  })

  it('言葉の時刻の無い「ん」×6 を 20 秒は捨て、本当の「んー」「んんん」は残す', () => {
    expect(kept([{ text: 'んんんんんん', start: 0, end: 20 }])).toEqual([])
    const real: TimedText[][] = [
      [{ text: 'んー', start: 0, end: 3 }],
      [{ text: 'んーーー、んーーー', start: 10, end: 16 }],
      [{ text: 'んんん', start: 20, end: 23.5 }],
      [{ text: 'ん、ん、ん、ん、ん', start: 30, end: 35 }]
    ]
    for (const items of real) expect(kept(items)).toEqual(items.map((x) => x.text))
  })
})

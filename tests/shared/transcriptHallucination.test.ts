import { describe, expect, it } from 'vitest'
import {
  fitSegmentsToRange,
  hallucinatedIndices,
  isLikelyHallucination,
  type TimedText
} from '../../src/shared/transcript'

/**
 * 音楽・効果音の区間で音声認識が作る「繰り返しの作り話」(実地テスト: Tears of Steel)。
 * 1枚のテロップが 10〜20 秒出続けていた。本当に繰り返して話した言葉は消さない
 */

/** 文字を言葉に分け、区間に均等に並べる(認識の言葉の時刻の代わり) */
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

describe('繰り返しの作り話(発話の時刻を見る)', () => {
  it('1文字の繰り返しが話す速さに比べて極端に遅い(「んんん…」を 20 秒)なら捨てる', () => {
    expect(kept([timed('んんんんんんんんんんん', 128.35, 150.34)])).toEqual([])
    expect(kept([timed('22222222222', 168.12, 191.09, 3)])).toEqual([])
  })

  it('短い言葉の少ない回数の繰り返しでも、遅すぎれば捨てる(「2分間」×4 を 10 秒)', () => {
    expect(kept([timed('2分間2分間2分間2分間', 45.16, 54.91, 4)])).toEqual([])
    expect(kept([timed('アバー!カッ!ヌー!ヌー!ヌー!ヌー!ヌー!', 74.25, 93.75, 7)])).toEqual([])
  })

  it('発話をまたいだ繰り返しも見る(前の「2分間」も一緒に捨て、離れた発話は残す)', () => {
    const items = [
      timed('私たちが、素晴らしいです', 31.19, 32.02, 4),
      timed('2分間', 40.96, 44.98),
      timed('2分間2分間2分間2分間', 45.16, 54.91, 4),
      timed('でも、世界の世界に無理を壊すことはできない。', 66.2, 70, 6)
    ]
    expect(kept(items)).toEqual([
      '私たちが、素晴らしいです',
      'でも、世界の世界に無理を壊すことはできない。'
    ])
  })

  it('同じ文が何度も続けば、区切りが文と合っていなくても捨てる(5語ごとの区切り)', () => {
    const words = Array.from({ length: 13 }, () => "I'm going to get the car.".split(' ')).flat()
    const segs: TimedText[] = []
    for (let i = 0; i < words.length; i += 5) {
      const ws = words.slice(i, i + 5)
      const t0 = 160 + i * 0.5
      segs.push({
        text: ws.join(' '),
        start: t0,
        end: t0 + ws.length * 0.5,
        words: ws.map((w, k) => ({
          text: (k ? ' ' : '') + w,
          start: t0 + k * 0.5,
          end: t0 + k * 0.5 + 0.4
        }))
      })
    }
    expect(kept(segs)).toEqual([])
  })

  it('話す速さに対して文字が多すぎる(0.3 秒に 40 文字)なら捨てる', () => {
    expect(
      kept([
        timed(
          'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれ',
          10,
          10.3
        )
      ])
    ).toEqual([])
  })

  it('言葉の時刻に対して文字が少なすぎる(2 文字の言葉を 12 秒)なら捨てる。区切りの時刻だけの片は見ない', () => {
    expect(kept([timed('えっ', 100, 112)])).toEqual([])
    // 区切り(Whisper の segment)の時刻は無音をまたいで長いことがある。言葉の時刻が無ければ残す
    expect(kept([{ text: 'はい。', start: 0, end: 12 }])).toEqual(['はい。'])
  })

  it('本当に繰り返して話した言葉は残す', () => {
    const real = [
      timed('はいはいはい', 0, 1.2, 3),
      timed('ありがとうございます、ありがとうございます', 2, 5, 4),
      timed('ははははははははははははははははははは', 6, 9, 5),
      timed('やばいやばいやばい!', 10, 11.5, 3),
      timed('いけいけいけいけいけいけいけいけ!', 12, 15, 8),
      timed('うわあああああああああ!', 16, 18, 2),
      timed('えーーーーーーーーっ!', 19, 21, 2)
    ]
    expect(kept(real)).toEqual(real.map((x) => x.text))
    // ゆっくり区切って言った「はい、はい、はい」(言葉の間が空いている)
    const slow: TimedText = {
      text: 'はい、はい、はい',
      start: 0,
      end: 3.4,
      words: [
        { text: 'はい、', start: 0, end: 0.4 },
        { text: 'はい、', start: 1.5, end: 1.9 },
        { text: 'はい', start: 3.0, end: 3.4 }
      ]
    }
    expect(kept([slow])).toEqual([slow.text])
    // 発話をまたいだ「ありがとうございます」2回・相づち「うん」3回(間が空いている)
    const across = [
      timed('ありがとうございます', 30, 31.5, 3),
      timed('ありがとうございます', 31.8, 33.2, 3),
      timed('うん', 40, 40.4),
      timed('うん', 43, 43.3),
      timed('うん', 46, 46.4)
    ]
    expect(kept(across)).toEqual(across.map((x) => x.text))
    // ふつうの長い発話(言葉の間に長い間がある)
    const pause: TimedText = {
      text: 'はい。それでは始めます',
      start: 0,
      end: 12,
      words: [
        { text: 'はい。', start: 0, end: 0.5 },
        { text: 'それでは', start: 10, end: 10.8 },
        { text: '始めます', start: 10.8, end: 12 }
      ]
    }
    expect(kept([pause])).toEqual([pause.text])
  })

  it('時刻の無い判定(isLikelyHallucination)は、これまでどおり短い繰り返しを残す', () => {
    expect(isLikelyHallucination('2分間2分間2分間2分間')).toBe(false)
    expect(isLikelyHallucination("I'm going to get the car. ".repeat(6))).toBe(true)
  })
})

describe('fitSegmentsToRange — 自動テロップの作り話', () => {
  it('同じ文の繰り返し(5語ごとの区切り)と長さ 0 の区切りを捨て、ふつうの言葉は残す', () => {
    const words = Array.from({ length: 13 }, () => "I'm going to get the car.".split(' ')).flat()
    const segs: {
      start: number
      end: number
      text: string
      words: { start: number; end: number; text: string }[]
    }[] = []
    for (let i = 0; i < words.length; i += 5) {
      const ws = words.slice(i, i + 5)
      const t0 = 160 + i * 0.5
      const wl = ws.map((w, k) => ({
        text: (k ? ' ' : '') + w,
        start: t0 + k * 0.5,
        end: t0 + k * 0.5 + 0.4
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
    const real = [
      {
        text: 'Hello there.',
        start: 161,
        end: 162,
        words: [
          { text: 'Hello', start: 161, end: 161.5 },
          { text: ' there.', start: 161.5, end: 162 }
        ]
      },
      {
        text: 'Thank you, thank you.',
        start: 163,
        end: 164.5,
        words: [
          { text: 'Thank you,', start: 163, end: 163.7 },
          { text: ' thank you.', start: 163.8, end: 164.5 }
        ]
      }
    ]
    expect(fitSegmentsToRange(real, 160, 200, () => false).map((s) => s.text)).toEqual([
      'Hello there.',
      'Thank you, thank you.'
    ])
  })
})

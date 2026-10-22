import { describe, expect, it } from 'vitest'
import { asrGroupResults, groupAsrJobs, type AsrRawChunk } from '../../src/shared/diarize/groupJobs'
import { hallucinatedIndices, type TimedText } from '../../src/shared/transcript'

/**
 * 「彼らは」×9 の暴走(実地テスト: 英語の音を日本語に固定して認識)。前の発話の「彼らは」×3 の終わりの
 * 切れ端「彼ら」は窓の音の外の片なので捨て(`asrGroupResults`)、前の発話とつながって 12 回になり、
 * 文字だけの判定(2〜4 文字は 10 回)で捨てる。言葉の時刻の速さでは判定しない(本物の声でも時刻は潰れる)
 */

const w = (
  text: string,
  start: number,
  end: number
): { text: string; start: number; end: number } => ({
  text,
  start,
  end
})

type Word = { text: string; start: number; end: number }
/** 言葉の並びを書き換えられる片 */
type Timed = TimedText & { words: Word[] }

const kept = (items: TimedText[]): string[] => {
  const drop = hallucinatedIndices(items)
  return items.filter((_, i) => !drop.has(i)).map((x) => x.text)
}

/** 同じ言葉を等しい長さで並べる(人が繰り返して言う形) */
function even(unit: string, n: number, start: number, per: number): Timed {
  const words = Array.from({ length: n }, (_, i) => w(unit, start + i * per, start + (i + 1) * per))
  return { text: unit.repeat(n), start, end: start + n * per, words }
}

describe('時刻の付いた、少ない回数の繰り返しの暴走', () => {
  // 実例(英語 10 分): 発話 584.97〜587.77。言葉の時刻は認識のまま
  const loop9: Timed = {
    text: '彼らは'.repeat(9),
    start: 584.97,
    end: 587.77,
    words: [
      w('彼らは', 584.21, 585.81),
      w('彼らは', 585.81, 586.23),
      w('彼らは', 586.23, 586.25),
      w('彼らは', 586.25, 586.45),
      w('彼らは', 586.45, 586.95),
      w('彼らは', 586.95, 587.21),
      w('彼らは', 587.21, 587.61),
      w('彼らは', 587.61, 587.69),
      w('彼らは', 587.69, 587.85)
    ]
  }

  it('実例: 窓から作った前の発話(切れ端は捨てる)とつながった「彼らは」×9 を捨てる', () => {
    const [group] = groupAsrJobs([
      { id: 'u1', path: 'a.wav', start: 583.07, end: 584.26 },
      { id: 'u2', path: 'a.wav', start: 584.97, end: 587.77 }
    ])
    const ch = (text: string, s: number, e: number | null): AsrRawChunk => ({
      text,
      timestamp: [s, e]
    })
    const g0 = group.start
    const rel = (t: number): number => +(t - g0).toFixed(2)
    const out = asrGroupResults(group, '', [
      ch('彼らは', rel(583.09), rel(583.81)),
      ch('彼らは', rel(583.81), rel(584.09)),
      ch('彼らは', rel(584.09), rel(584.21)),
      ...loop9.words.map((x) => ch(x.text ?? '', rel(x.start), rel(x.end))),
      ch('彼ら', 29.82, 0)
    ])
    const items: TimedText[] = out.map((r, i) => ({
      text: r.text,
      start: [583.07, 584.97][i],
      end: [584.26, 587.77][i],
      words: r.words
    }))
    expect(items[0].text).toBe('彼らは彼らは彼らは')
    expect(kept(items)).toEqual([])
  })

  it('本物の日本語の速い繰り返しは、時刻が潰れた語が混ざっても残す', () => {
    const seq = (
      unit: string,
      n: number,
      per: number,
      collapse: number[],
      perChar = false
    ): Timed => {
      const words: Word[] = []
      let t = 10
      for (let i = 0; i < n; i++) {
        const d = collapse.includes(i) ? 0.02 : per
        if (perChar)
          [...unit].forEach((c, k, a) =>
            words.push(w(c, t + (d * k) / a.length, t + (d * (k + 1)) / a.length))
          )
        else words.push(w(unit, t, t + d))
        t += d
      }
      return { text: unit.repeat(n), start: 10, end: t, words }
    }
    const real = [
      seq('やばい', 6, 0.35, [2, 4]),
      seq('やばい', 7, 0.35, [3, 5], true),
      { ...seq('すごい', 6, 0.3, [1, 2]), text: 'すごい、'.repeat(6) }
    ]
    for (const r of real) expect(kept([r])).toEqual([r.text])
  })

  it('英語の短い掛け声(「go」×8・時刻の粗い語が2つ)は残す', () => {
    const ws = Array.from({ length: 8 }, (_, i) =>
      w('go', i * 0.25, i * 0.25 + (i === 3 || i === 6 ? 0.04 : 0.25))
    )
    const item: Timed = { text: Array(8).fill('go').join(' '), start: 0, end: 2, words: ws }
    expect(kept([item])).toEqual([item.text])
  })

  it('発話の頭・終わりで時刻が少しはみ出した本当の「やばい」×7 は残す(まとめて読んだ窓から)', () => {
    const [group] = groupAsrJobs([
      { id: 'u1', path: 'a.wav', start: 0, end: 8 },
      { id: 'u2', path: 'a.wav', start: 10, end: 12 }
    ])
    const ch = (text: string, s: number, e: number): AsrRawChunk => ({ text, timestamp: [s, e] })
    const out = asrGroupResults(group, '', [
      ch('こんにちは', 1, 2),
      ch('やばい', 9.85, 10.2),
      ch('やばい', 10.2, 10.6),
      ch('やばい', 10.6, 11.0),
      ch('やばい', 11.0, 11.4),
      ch('やばい', 11.4, 11.97),
      ch('やばい', 11.97, 12.2),
      ch('やばい', 12.2, 12.3)
    ])
    const r = out[1]
    expect(r.text).toBe('やばい'.repeat(7))
    const item: TimedText = { text: r.text, start: 10, end: 12, words: r.words }
    expect(kept([item])).toEqual([item.text])
  })

  it('実例の前の発話(「彼らは」×3)とつながった形でも捨てる', () => {
    const before: Timed = {
      text: '彼らは彼らは彼らは',
      start: 583.07,
      end: 584.26,
      words: [w('彼らは', 583.09, 583.81), w('彼らは', 583.81, 584.09), w('彼らは', 584.09, 584.21)]
    }
    const loop = even('彼らは', 9, 584.97, 0.31)
    expect(kept([before, loop])).toEqual([])
  })

  it('回数が少ない(5 回)なら、短い片が混ざっても文字だけの判定に任せる', () => {
    const five = even('彼らは', 5, 0, 0.3)
    five.words[1] = w('彼らは', 0.3, 0.32)
    five.words[2] = w('彼らは', 0.32, 0.34)
    expect(kept([five])).toEqual([five.text])
  })
})

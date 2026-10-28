import { describe, expect, it } from 'vitest'
import { buildScenes, splitInnerTurns, type TimedLine } from '../../src/shared/structure/scenes'
import { quietestIn } from '../../src/shared/roughCut/snap'
import { TURN_RATE } from '../../src/shared/diarize/micTurns'
import { TRIAL4_TRANSCRIPT } from './fixtures/trial4Transcript'

/**
 * 第4回の直し(N5)の監査の指摘 4: 語の時刻が無い(字と合わない)発話を、字数の割合で見積もった時刻で分けて
 * いたので、場面の境が声の途中に入りうる(89.86 秒は元の発話 76.24〜92.55 秒の内側)。前後 1 秒の中の
 * いちばん静かな所(音の強さ、無ければ語と語の間)へ寄せ、静かな所が無ければ分けない
 */
const merged = (): TimedLine => {
  const i = TRIAL4_TRANSCRIPT.findIndex(([, , t]) => t.startsWith('賃上げは大企業とか'))
  const [start, end, text] = TRIAL4_TRANSCRIPT[i]
  return { id: `u${i}`, speaker: 'マイク1', start, end, text, overlap: false }
}
/** 76〜93 秒ずっと声(-20dB)。`dipAt` の所だけ 0.3 秒の静かな所(-60dB) */
const level = (dipAt?: number): Float32Array => {
  const a = new Float32Array(120 * TURN_RATE).fill(-70)
  for (let k = 76 * TURN_RATE; k < 93 * TURN_RATE; k++) a[k] = -20
  if (dipAt !== undefined)
    for (let k = Math.round((dipAt - 0.15) * TURN_RATE); k < (dipAt + 0.15) * TURN_RATE; k++)
      a[k] = -60
  return a
}

describe('字数で見積もった切れ目は静かな所へ寄せ、無ければ分けない', () => {
  it('語の時刻も音も無ければ分けない(声の途中で場面を区切らない)', () => {
    expect(splitInnerTurns([merged()])).toHaveLength(1)
  })

  it('音の強さ: 前後 1 秒の中の静かな所で分ける。静かな所が無ければ分けない', () => {
    const dip = level(90.5)
    const pieces = splitInnerTurns([merged()], (lo, hi) => quietestIn(dip, lo, hi))
    expect(pieces).toHaveLength(2)
    expect(Math.abs(pieces[1].start - 90.5)).toBeLessThan(0.1)
    expect(pieces[0].end).toBe(pieces[1].start)
    // 静かな所が 1 秒より遠い(88 秒)・どこにも無い
    for (const far of [level(88), level()])
      expect(splitInnerTurns([merged()], (lo, hi) => quietestIn(far, lo, hi))).toHaveLength(1)
  })

  it('語の時刻が字と合わなければ、前後 1 秒の中のいちばん長い語と語の間で分ける', () => {
    const m = merged()
    const l: TimedLine = {
      ...m,
      words: [
        { text: '賃上げは…考えております', start: 76.24, end: 89.6 },
        { text: '実は', start: 90.1, end: 90.4 },
        { text: '千崎社長の日立健貴さんは', start: 90.45, end: 92.55 }
      ]
    }
    const pieces = splitInnerTurns([l])
    expect(pieces).toHaveLength(2)
    expect(pieces[0].end).toBe(89.6)
    expect(pieces[1].start).toBe(90.1)
    // 間が 1 秒より遠いだけなら分けない
    const far: TimedLine = {
      ...m,
      words: [
        { text: 'a', start: 76.24, end: 86 },
        { text: 'b', start: 86.6, end: 92.55 }
      ]
    }
    expect(splitInnerTurns([far])).toHaveLength(1)
  })

  it('場面の境: 静かな所に置く(見積もりの 89.86 秒の声の途中に置かない)', () => {
    const lines: TimedLine[] = TRIAL4_TRANSCRIPT.map(([start, end, text], i) => ({
      id: `u${i}`,
      speaker: 'マイク1',
      start,
      end,
      text,
      overlap: false
    }))
    const dip = level(90.5)
    const scenes = buildScenes(
      lines,
      { start: 0, end: 660 },
      { quietCut: (lo, hi) => quietestIn(dip, lo, hi) }
    )
    for (const s of scenes.slice(1))
      if (s.start > 76.24 && s.start < 92.55) expect(Math.abs(s.start - 90.5)).toBeLessThan(0.1)
    // 音が無ければ、元の発話の内側に境を置かない
    for (const s of buildScenes(lines, { start: 0, end: 660 }).slice(1))
      expect(s.start > 76.24 && s.start < 92.55).toBe(false)
  })
})

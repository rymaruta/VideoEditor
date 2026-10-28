import { describe, expect, it } from 'vitest'
import {
  formatShortDuration,
  formatTimecode,
  parseTimecode,
  rulerStep,
  rulerTicks,
  rulerTiers,
  timecodeEntryValue
} from '@renderer/lib/timelineRuler'
import { NASTY_NUMBERS } from '../helpers/boundary'

describe('timelineRuler — 時間目盛り', () => {
  it('時:分:秒:フレーム', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00')
    expect(formatTimecode(1374.4667, 30)).toBe('00:22:54:14')
    expect(formatTimecode(3600, 30)).toBe('01:00:00:00')
    expect(formatTimecode(1 / 30, 30)).toBe('00:00:00:01')
    for (const v of NASTY_NUMBERS)
      expect(formatTimecode(v, 30)).toMatch(/^\d{2}:\d{2}:\d{2}:\d{2}$/)
    expect(formatTimecode(Number.MAX_VALUE, 30)).toBe('99:00:00:00')
  })

  it('間隔は数字が重ならない最小のもの', () => {
    expect(rulerStep(40, 30)).toBe(5) // 40px/秒 → 5秒で 200px(2秒だと 80px で足りない)
    expect(rulerStep(1000, 30)).toBeCloseTo(1 / 6) // 5フレーム = 167px(1フレームでは 33px で足りない)
    expect(rulerStep(0.01, 30)).toBe(3600)
    expect(rulerStep(0, 30)).toBe(3600)
  })

  it('見えている範囲の目盛りだけ・間隔の整数倍', () => {
    expect(rulerTicks(12, 31, 5)).toEqual([15, 20, 25, 30])
    expect(rulerTicks(-10, 4, 2)).toEqual([0, 2, 4])
    expect(rulerTicks(0, 1e9, 1)).toHaveLength(400)
    expect(rulerTicks(5, 1, 1)).toEqual([])
    expect(rulerTicks(0, 10, 0)).toEqual([])
  })
})

describe('rulerTiers — 目盛りの 3 段(デザイン案: 2 秒 / 10 秒 / 30 秒)', () => {
  it('案の拡大(約 4.2px/秒)では 30 秒ごとに数字、10 秒・2 秒の目盛り', () => {
    expect(rulerTiers(1256 / 300, 30)).toEqual({ label: 30, mid: 10, minor: 2 })
  })
  it('拡大すると間隔が細かくなり、縮めると粗くなる(数字は重ならない)', () => {
    const near = rulerTiers(40, 30)
    expect(near.label).toBe(5)
    expect(near.label * 40).toBeGreaterThanOrEqual(110)
    const far = rulerTiers(0.5, 30)
    expect(far.label).toBeGreaterThanOrEqual(300)
    expect(far.label * 0.5).toBeGreaterThanOrEqual(110)
  })
  it('詰まりすぎる細かい目盛りは出さない', () => {
    const t = rulerTiers(1.9, 30) // 60 秒ごと: 10 秒の目盛りは 19px、細かい目盛りの段は 10 秒 → 出す
    expect(t.label).toBe(60)
    for (const pps of [0.01, 0.37, 1, 4.19, 13, 40, 160, 1000]) {
      const r = rulerTiers(pps, 30)
      if (r.mid !== null) expect(r.mid * pps).toBeGreaterThanOrEqual(12)
      if (r.minor !== null) expect(r.minor * pps).toBeGreaterThanOrEqual(4)
      if (r.mid !== null) expect(r.label % r.mid).toBeCloseTo(0)
    }
  })
  it('1 コマより細かい目盛りは作らない', () => {
    const r = rulerTiers(2000, 30)
    if (r.minor !== null) expect(r.minor).toBeGreaterThanOrEqual(1 / 30 - 1e-9)
  })
})

describe('formatTimecode — 29.97 / 59.94 はドロップフレーム', () => {
  const ntsc = 30000 / 1001
  const at = (frame: number, fps = ntsc): string => formatTimecode(frame / fps, fps)

  it('1コマずつ進めたとき番号が飛ばない(毎分の頭の 2 コマだけ飛ばす)', () => {
    expect(at(499)).toBe('00:00:16;19')
    expect(at(500)).toBe('00:00:16;20')
    expect(at(1799)).toBe('00:00:59;29')
    expect(at(1800)).toBe('00:01:00;02')
  })

  it('10 分ちょうどは 00:10:00;00(実時間とずれない)', () => {
    expect(at(17982)).toBe('00:10:00;00')
    expect(at(17982 * 6)).toBe('01:00:00;00')
    expect(at(35964, 60000 / 1001)).toBe('00:10:00;00')
  })

  it('整数のフレームレートは今までどおり', () => {
    expect(formatTimecode(61.5, 30)).toBe('00:01:01:15')
    expect(formatTimecode(1, 25)).toBe('00:00:01:00')
  })
})

describe('formatTimecode — NTSC 以外の半端なレート', () => {
  it('30.3 や 29.5 はドロップフレームにせず、実時間どおりに数える', () => {
    expect(formatTimecode(600, 30.3)).toBe('00:10:00:00')
    expect(formatTimecode(600, 29.5)).toBe('00:10:00:00')
    expect(formatTimecode(60, 90000 / 3001)).toBe('00:01:00:00')
  })
})

describe('formatTimecode — 23.976fps', () => {
  it('コマの番号を飛ばさない(本当のコマを 24 進で数える)', () => {
    const fps = 24000 / 1001
    const label = (n: number): number => {
      const t = formatTimecode((n * 1001) / 24000, fps)
      const [h, m, s, f] = t.split(':').map(Number)
      return ((h * 60 + m) * 60 + s) * 24 + f
    }
    for (let n = 495; n < 505; n++) expect(label(n + 1) - label(n)).toBe(1)
    expect(formatTimecode((86400 * 1001) / 24000, fps)).toBe('01:00:00:00')
  })
})

describe('parseTimecode — タイムコードの入力欄', () => {
  it('時:分:秒:フレームを秒に。後ろから詰めて読む', () => {
    expect(parseTimecode('00:01:52:10', 30)).toBeCloseTo(112 + 10 / 30)
    expect(parseTimecode('12:05', 30)).toBeCloseTo(12 + 5 / 30)
    expect(parseTimecode('1:00:00', 30)).toBe(60)
    expect(parseTimecode('100', 30)).toBe(1)
    expect(parseTimecode('10000', 30)).toBe(60)
    expect(parseTimecode(' 00:00:02:00 ', 25)).toBe(2)
  })
  it('読めない・範囲の外は null', () => {
    for (const bad of [
      '',
      'abc',
      '1a',
      '00:61:00:00',
      '00:00:60:00',
      '00:00:00:30',
      '1:2:3:4:5',
      '-1',
      '-00:00:01:00',
      '123456789'
    ])
      expect(parseTimecode(bad, 30)).toBeNull()
  })
  it('formatTimecode と行って戻って同じ(整数・ドロップフレーム・23.976)', () => {
    for (const fps of [24, 25, 30, 60, 30000 / 1001, 60000 / 1001, 24000 / 1001]) {
      for (const frame of [0, 1, 499, 1799, 1800, 17982, 107892]) {
        const t = frame / fps
        const back = parseTimecode(formatTimecode(t, fps), fps)
        expect(back).not.toBeNull()
        expect(Math.round(back! * fps)).toBe(frame)
      }
    }
  })
})

describe('formatShortDuration — 素材の格子の長さの札', () => {
  it('M:SS、1 時間を超えたら H:MM:SS。おかしな値は 0:00', () => {
    expect(formatShortDuration(192.4)).toBe('3:12')
    expect(formatShortDuration(734)).toBe('12:14')
    expect(formatShortDuration(3725)).toBe('1:02:05')
    expect(formatShortDuration(NaN)).toBe('0:00')
    expect(formatShortDuration(-3)).toBe('0:00')
  })
})

describe('タイムコードの入力欄(監査の確かめを取り込んだもの)', () => {
  const df = 30000 / 1001
  it('`.` を含む数は秒の小数として読む', () => {
    expect(parseTimecode('12.5', 30)).toBe(12.5)
    expect(parseTimecode('1.5', 24)).toBe(1.5)
    expect(parseTimecode('.5', 30)).toBe(0.5)
  })
  it('ドロップフレームで存在しない番号は、次の有効な番号として読む', () => {
    // 00:01:00;00 と ;01 は飛ばす番号 → 00:01:00;02
    for (const t of ['00:01:00;00', '00:01:00;01'])
      expect(formatTimecode(parseTimecode(t, df)!, df)).toBe('00:01:00;02')
    expect(formatTimecode(parseTimecode('00:01:00;02', df)!, df)).toBe('00:01:00;02')
    // 10 分ごとは飛ばさない
    expect(formatTimecode(parseTimecode('00:10:00;00', df)!, df)).toBe('00:10:00;00')
    // 59.94 は 4 つ飛ばす
    expect(formatTimecode(parseTimecode('00:01:00;03', 60000 / 1001)!, 60000 / 1001)).toBe(
      '00:01:00;04'
    )
  })
  it('ドロップフレームの最初の 20 分は、全部のコマで行って戻って同じ', () => {
    let bad = 0
    for (let f = 0; f < 30 * 60 * 20; f++) {
      const back = parseTimecode(formatTimecode(f / df, df), df)!
      if (Math.round(back * df) !== f) bad++
    }
    expect(bad).toBe(0)
  })
  it('整数・23.976・範囲の外・レートが壊れているとき', () => {
    expect(parseTimecode('00:00:01:23', 24)).toBeCloseTo(1 + 23 / 24)
    expect(parseTimecode('00:00:01:24', 24)).toBeNull()
    expect(parseTimecode('01:00:00:00', 24000 / 1001)).toBeCloseTo(3600 * 1.001)
    expect(parseTimecode('99:59:59:29', 30)).toBeCloseTo(99 * 3600 + 59 * 60 + 59 + 29 / 30)
    expect(parseTimecode('00:00:05:00', NaN)).toBe(5)
  })
  it('開いたときのまま Enter を押しても決めない(半端な時刻を丸めて動かさない・取り消しに積まない)', () => {
    const opened = formatTimecode(9.99, 30)
    expect(timecodeEntryValue(opened, opened, 30, 0)).toBe('unchanged')
    expect(timecodeEntryValue(` ${opened} `, opened, 30, 0)).toBe('unchanged')
    expect(timecodeEntryValue('00:00:05:00', opened, 30, 0)).toBe(5)
    expect(timecodeEntryValue('00:00:50:00', opened, 30, 0, 20)).toBe(20)
    expect(timecodeEntryValue('abc', opened, 30, 0)).toBeNull()
  })
})

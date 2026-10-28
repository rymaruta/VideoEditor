import { describe, expect, it } from 'vitest'
import { formatTimecode, lengthClock } from '@renderer/lib/timelineRuler'

/**
 * 試し編集 第3回の N5: 仕上がりの長さが確認の画面 7:21・編集画面と書き出し 7:22 と 1 秒違った。
 * 確認の画面は秒を切り捨て、書き出しの画面は四捨五入、編集画面はコマに丸めた時刻で数えていた
 */
describe('長さの表示を編集画面の時刻・書き出しと同じ数え方にする', () => {
  it('441.98 秒(コマに丸めると 442.0 秒)は 7:22', () => {
    expect(formatTimecode(441.984, 30)).toBe('00:07:22:00')
    expect(lengthClock(441.984, 30)).toBe('7:22')
  })

  it('秒の端数はコマに丸めてから切り捨てる(441.6 秒は 00:07:21:18 なので 7:21)', () => {
    expect(formatTimecode(441.6, 30)).toBe('00:07:21:18')
    expect(lengthClock(441.6, 30)).toBe('7:21')
  })

  it('どの長さでも、編集画面の時刻の「分:秒」と同じ(25・30・60 fps)', () => {
    for (const fps of [25, 30, 60])
      for (let i = 0; i < 2000; i++) {
        const sec = (i * 7.31337) % 4000
        const tc = formatTimecode(sec, fps)
        const [hh, mm, ss] = tc.split(/[:;]/).map(Number)
        const want =
          hh > 0
            ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
            : `${mm}:${String(ss).padStart(2, '0')}`
        expect(lengthClock(sec, fps), `${sec} ${fps}`).toBe(want)
      }
  })

  it('壊れた値は 0:00', () => {
    expect(lengthClock(Number.NaN, 30)).toBe('0:00')
    expect(lengthClock(-3, 30)).toBe('0:00')
    expect(lengthClock(12, 0)).toBe('0:12')
  })
})

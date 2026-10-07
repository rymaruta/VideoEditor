import { describe, expect, it } from 'vitest'
import { tightenRanges } from '../../src/shared/cut/tighten'
import { TURN_RATE } from '../../src/shared/diarize/micTurns'
import { peakWindows, widenToLines } from '../../src/shared/structure/hype'
import { pickShortWindows } from '../../src/shared/structure/shorts'
import { stackSimultaneousTelops, stackedBottomTelops } from '../../src/shared/telop/stack'
import { settleTelopTimes } from '../../src/shared/telop/fromTranscript'
import type { TextStyle } from '../../src/shared/types'

/**
 * ゲーム実況の監査(2026-10-07)で見つけた不具合の再発防止。
 * 鳴らすトラック・Craig の名前は `gameTracks.test.ts`、顔カメラの音は `gameTracksReal`(本物の書き出し)
 */

describe('発話の途中で区間を切らない(広げた先がまた発話の途中でも)', () => {
  // 重なる掛け合い: A 10〜14、B 12〜20、C 18〜25
  const lines = [
    { start: 10, end: 14 },
    { start: 12, end: 20 },
    { start: 18, end: 25 }
  ]
  it('動かなくなるまで広げる', () => {
    expect(widenToLines(13, 15, lines)).toEqual([10, 25])
    expect(widenToLines(5, 8, lines)).toEqual([5, 8])
  })
  it('山の前後の区間・ショートの区間も同じ', () => {
    const w = peakWindows(
      { start: 0, end: 100 },
      [{ start: 15, end: 15.5, lead: 1, tail: 0 }],
      lines
    )
    expect(w).toEqual([{ start: 10, end: 25 }])
    const shorts = pickShortWindows(
      [{ start: 15, end: 15.5, riseDb: 10 }],
      [],
      lines,
      { start: 0, end: 100 },
      { leadSec: 1, tailSec: 0, minSec: 1 }
    )
    expect(shorts[0].start).toBe(10)
    expect(shorts[0].end).toBe(25)
  })
})

describe('詰めた区間が隣と重ならない(同じ絵を2度使わない)', () => {
  it('ランダムな発話と場面の切れ目で、区間はいつも前の区間の終わりより後から始まる', () => {
    let seed = 7
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let trial = 0; trial < 3000; trial++) {
      const seconds = 60
      const activity = new Uint8Array(seconds * TURN_RATE)
      const speech: { start: number; end: number }[] = []
      for (let t = rand() * 3; t < seconds - 1;) {
        const len = 0.3 + rand() * 3
        speech.push({ start: t, end: Math.min(seconds, t + len) })
        activity.fill(
          1,
          Math.floor(t * TURN_RATE),
          Math.ceil(Math.min(seconds, t + len) * TURN_RATE)
        )
        t += len + rand() * 6
      }
      // 場面の切れ目は 10ms の格子に乗らない時刻
      const cuts = [0, ...[1, 2, 3].map((k) => k * 15 + rand() * 0.013), seconds]
      const ranges = cuts.slice(1).map((end, i) => ({ start: cuts[i], end, sceneId: `s${i}` }))
      const out = tightenRanges(ranges, activity, speech)
      for (let i = 1; i < out.length; i++)
        expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end - 1e-9)
    }
  })
})

describe('テロップは本編の終わりを越えない', () => {
  it('読み切れない枚を延ばすときも、終わりで止める', () => {
    const out = settleTelopTimes(
      [{ text: 'さいごのひとこと、ながめのセリフ', startTime: 9.5, endTime: 9.8 }],
      [10]
    )
    expect(out[0].endTime).toBeLessThanOrEqual(10)
  })
})

describe('段に積んだ発言テロップを、まとめて上げる(HUD を避ける)', () => {
  const style = { position: 'bottom', fontSize: 52 } as unknown as TextStyle
  const telops = [
    { text: 'さきにでた', style, startTime: 0, endTime: 4 },
    { text: 'かさなった', style, startTime: 1, endTime: 3 },
    {
      text: '手で置いた',
      style: { ...style, customPosition: { x: 0.3, y: 0.9 } },
      startTime: 1,
      endTime: 2
    }
  ]
  const H = 1080
  it('積んだものは段のテロップ、手で置いたものは違う', () => {
    const stacked = stackSimultaneousTelops(telops, H)
    expect(stackedBottomTelops(stacked, H)).toEqual([true, true, false])
  })
  it('一番下の段を指定の高さに置き、上の段はそこから積む', () => {
    const lifted = stackSimultaneousTelops(telops, H, { baseCenter: 0.7 })
    expect(lifted[0].style.customPosition).toEqual({ x: 0.5, y: 0.7 })
    expect(lifted[1].style.customPosition!.y).toBeLessThan(0.7 - 52 / H)
    expect(lifted[2].style.customPosition).toEqual({ x: 0.3, y: 0.9 })
  })
})

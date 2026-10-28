import { describe, expect, it } from 'vitest'
import { buildScenes, type TimedLine } from '../../src/shared/structure/scenes'
import { TRIAL4_TRANSCRIPT } from './fixtures/trial4Transcript'

/**
 * 第4回の直し(N4)の監査の指摘 2: 続きのある形で終わる発話の後の間(4〜8 秒)を全部つないだので、場面が
 * 減りすぎ(合成で 10930 → 5869)、つなぐ前の長さしか見ずに上限(長さの目安の 1.5 倍)を超える場面ができた
 * (第4回で 136.4 秒)。文の途中で始まる短いまとまりだけを前へ戻し、戻した後の長さで上限を見る
 */
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// 半分は続きのある形で終わる
const TEXTS = [
  'それで現場ではいろいろな工夫をしてきまして',
  'あとやはり我々は',
  '一緒に頑張っていこうという形で',
  '地元の高校との結び付きを強めてきました',
  'ものすごい挑戦だったというふうに思うんです',
  '私どもでは採用の方法を変えました',
  'そういうことも含めて当然いったら',
  '賃上げを予定してございます'
]
/** 種ごとに 30 分。間はたいてい短く、2 割が 1〜4 秒、1 割が 4〜8 秒 */
function corpus(seed: number): { lines: TimedLine[]; end: number } {
  const r = rng(seed)
  const lines: TimedLine[] = []
  let t = 0
  while (t < 1800) {
    const d = 1 + r() * 6
    lines.push({
      id: `l${lines.length}`,
      start: t,
      end: t + d,
      text: TEXTS[Math.floor(r() * TEXTS.length)],
      overlap: false
    })
    const x = r()
    t += d + (x < 0.7 ? 0.1 + r() * 0.8 : x < 0.9 ? 1 + r() * 2.9 : 4 + r() * 3.9)
  }
  return { lines, end: t }
}
/** 同じ合成 300 回を、つなぐ直しの前の版(0f27f36)で分けた場面の数 */
const OLD_COUNT = 10955

describe('場面を減らしすぎず、つないだ後も上限に収める', () => {
  it('合成 300 回: 場面の数は前の版の ±15% 以内。発話の範囲は上限(135 秒)+ 1 行に収まる', () => {
    let count = 0
    let longest = 0
    for (let seed = 1; seed <= 300; seed++) {
      const { lines, end } = corpus(seed)
      const scenes = buildScenes(lines, { start: 0, end })
      count += scenes.length
      for (const s of scenes) {
        if (s.lines.length === 0) continue
        longest = Math.max(longest, Math.max(...s.lines.map((l) => l.end)) - s.lines[0].start)
      }
    }
    expect(count).toBeGreaterThanOrEqual(OLD_COUNT * 0.85)
    expect(count).toBeLessThanOrEqual(OLD_COUNT * 1.15)
    expect(longest).toBeLessThanOrEqual(90 * 1.5 + 7.5)
  })

  it('第4回の実文: どの場面も、最後の発話を足す前の範囲が上限(135 秒)未満(つないで超えない)', () => {
    const lines: TimedLine[] = TRIAL4_TRANSCRIPT.map(([start, end, text], i) => ({
      id: `u${i}`,
      speaker: 'マイク1',
      start,
      end,
      text,
      overlap: false
    }))
    for (const s of buildScenes(lines, { start: 0, end: 660 })) {
      if (s.lines.length === 0) continue
      const ends = s.lines.map((l) => l.end)
      const before = Math.max(s.lines[0].end, ...ends.slice(0, -1)) - s.lines[0].start
      expect(before, s.id).toBeLessThan(135)
    }
  })
})

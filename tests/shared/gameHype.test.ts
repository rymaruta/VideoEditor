import { describe, expect, it } from 'vitest'
import { TURN_RATE } from '../../src/shared/diarize/micTurns'
import {
  countHype,
  detectHype,
  lineLoudness,
  peakWindows,
  type HypeLine
} from '../../src/shared/structure/hype'
import { heuristicJudgements, selectScenes, type Scene } from '../../src/shared/structure/scenes'
import { DEFAULT_POLICY, POLICY_PROFILES } from '../../src/shared/structure/kind'

/** 秒の区間ごとの大きさ(dB)を 100Hz の列にする。区間の外は静か(-60dB) */
function level(seconds: number, parts: [number, number, number][]): Float32Array {
  const out = new Float32Array(seconds * TURN_RATE).fill(-60)
  for (const [a, b, db] of parts) out.fill(db, Math.round(a * TURN_RATE), Math.round(b * TURN_RATE))
  return out
}

describe('声の盛り上がり(detectHype)', () => {
  it('同じ話者の普段の声から 6dB 以上上がった発話を拾い、声の無い所の大きな音は数えない', () => {
    const lines: HypeLine[] = []
    const parts: [number, number, number][] = []
    for (let t = 0; t < 120; t += 5) {
      const shout = t === 40 || t === 90
      lines.push({ start: t, end: t + 2, speaker: 'A' })
      parts.push([t, t + 2, shout ? -8 : -20])
    }
    // 声の無い所(発話の外)で鳴る爆発音
    parts.push([62.5, 64, 0])
    const lv = level(130, parts)
    const hype = detectHype(lines, () => lv)
    expect(hype.map((h) => h.start)).toEqual([40, 90])
    expect(hype[0].riseDb).toBeCloseTo(12, 6)
  })

  it('声の大きい人・小さい人を、それぞれの普段の声で比べる(決まった dB で切らない)', () => {
    const lines: HypeLine[] = []
    const a: [number, number, number][] = []
    const b: [number, number, number][] = []
    for (let t = 0; t < 100; t += 4) {
      lines.push({ start: t, end: t + 1.5, speaker: 'loud' })
      a.push([t, t + 1.5, -10])
      lines.push({ start: t + 2, end: t + 3.5, speaker: 'quiet' })
      b.push([t + 2, t + 3.5, t === 48 ? -22 : -30])
    }
    const lvA = level(110, a)
    const lvB = level(110, b)
    const hype = detectHype(lines, (l) => (l.speaker === 'loud' ? lvA : lvB))
    // ずっと大きい声の人は一度も「叫んで」いない。小さい声の人の +8dB は拾う
    expect(hype).toHaveLength(1)
    expect(hype[0].start).toBe(50)
  })

  it('近い叫びは1回にまとめ、区間の中の数を数える', () => {
    const lines: HypeLine[] = []
    const parts: [number, number, number][] = []
    for (let t = 0; t < 60; t += 3) {
      const shout = t === 30 || t === 33
      lines.push({ start: t, end: t + 1.5 })
      parts.push([t, t + 1.5, shout ? -5 : -20])
    }
    const hype = detectHype(lines, () => level(70, parts))
    expect(hype).toHaveLength(1)
    expect(hype[0].end).toBeCloseTo(34.5, 6)
    expect(countHype(hype, 0, 31)).toBe(0)
    expect(countHype(hype, 31, 40)).toBe(1)
  })

  it('測れない所(録っていない・短すぎる)は null', () => {
    expect(lineLoudness(new Float32Array(100).fill(NaN), 0, 1)).toBeNull()
    expect(lineLoudness(new Float32Array(1000).fill(-20), 1, 1.05)).toBeNull()
  })
})

describe('山の前後だけ残す(peakWindows)', () => {
  it('前 12 秒・後 8 秒。端が発話に掛かれば発話を丸ごと入れ、近い区間はつなぐ', () => {
    const scene = { start: 0, end: 100 }
    const lines = [
      { start: 15, end: 19 },
      { start: 26, end: 31 }
    ]
    const peaks = [
      { start: 30, end: 31, lead: 12, tail: 8 },
      { start: 45, end: 46, lead: 12, tail: 8 }
    ]
    // 30 秒の山: 18〜39 → 頭が発話 15〜19 の途中なので 15 から。45 秒の山: 33〜54 → つながる
    expect(peakWindows(scene, peaks, lines)).toEqual([{ start: 15, end: 54 }])
    // 山の無い場面は丸ごと(null)
    expect(peakWindows({ start: 60, end: 100 }, peaks, lines)).toBeNull()
  })
})

describe('ゲーム実況の簡易の点数と方針', () => {
  const line = (s: number, e: number, text = 'うん'): Scene['lines'][number] => ({
    id: `l${s}`,
    start: s,
    end: e,
    text,
    overlap: false
  })
  const scenes: Scene[] = [
    // 落ち着いた解説(ずっと話しているが盛り上がりは無い)
    { id: 'calm', start: 0, end: 40, lines: [line(0, 38)], speech: 38 },
    // 叫び2回
    { id: 'hot', start: 40, end: 80, lines: [line(40, 78)], speech: 38, hype: 2 },
    // 黙々とプレイ(ほとんど話さない)
    { id: 'quiet', start: 80, end: 120, lines: [line(100, 102)], speech: 2 }
  ]
  const j = heuristicJudgements(scenes, 'game')

  it('叫び・笑いのある場面を見どころに、黙々とプレイする場面を不要にする。話し続けるだけでは点が伸びない', () => {
    const by = new Map(j.map((x) => [x.sceneId, x]))
    expect(by.get('hot')!.kind).toBe('highlight')
    expect(by.get('quiet')!.kind).toBe('unneeded')
    expect(by.get('calm')!.kind).toBe('normal')
    expect(by.get('calm')!.score).toBeLessThan(POLICY_PROFILES.highlights.minScoreWithoutTarget)
    // ロケの点数では、話し続ける場面は高い
    const loc = heuristicJudgements(scenes, 'location').find((x) => x.sceneId === 'calm')!
    expect(loc.score).toBeGreaterThan(by.get('calm')!.score)
  })

  it('面白い所だけ: 盛り上がりの無い場面も落とす。軽く整える: 不要の場面も落とさない', () => {
    const hi = POLICY_PROFILES.highlights
    expect(selectScenes(scenes, j, Infinity, undefined, hi.minScoreWithoutTarget).kept).toEqual([
      'hot'
    ])
    expect(selectScenes(scenes, j, Infinity).kept).toEqual(['calm', 'hot'])
    const light = POLICY_PROFILES.light
    expect(
      selectScenes(scenes, j, Infinity, undefined, light.minScoreWithoutTarget, light.dropUnneeded)
        .kept
    ).toEqual(['calm', 'hot', 'quiet'])
    expect(DEFAULT_POLICY).toEqual({ location: 'tempo', game: 'highlights' })
  })
})

describe('AI への頼み方(ゲーム実況)', () => {
  it('実況の編集者として頼み、叫びの回数を渡す。長さを決めないときは「面白い所だけ」と頼む', async () => {
    const { buildStructurePrompt } = await import('../../src/shared/structure/llm')
    const scene = {
      id: 's1',
      start: 0,
      end: 30,
      lines: [{ id: 'l', start: 0, end: 2, text: 'うわああ', overlap: false, speaker: '実況者' }],
      speech: 2,
      hype: 2
    }
    const game = buildStructurePrompt([scene], 600, {
      episodeName: 'テスト',
      targetSec: 0,
      kind: 'game'
    })
    expect(game).toContain('ゲーム実況動画の編集者')
    expect(game).toContain('叫び・大声2回')
    expect(game).toContain('面白い所だけを残して')
    expect(game).toContain('黙々とプレイ')
    const loc = buildStructurePrompt([scene], 600, { episodeName: 'テスト', targetSec: 300 })
    expect(loc).toContain('ロケ番組')
  })
})

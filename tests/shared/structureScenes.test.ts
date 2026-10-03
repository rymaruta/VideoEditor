import { describe, expect, it } from 'vitest'
import {
  buildScenes,
  heuristicJudgements,
  selectScenes,
  type TimedLine
} from '../../src/shared/structure/scenes'

let n = 0
const line = (start: number, end: number, speaker = 'A', text = 'こんにちは'): TimedLine => ({
  id: `l${++n}`,
  speaker,
  start,
  end,
  text,
  overlap: false
})

describe('buildScenes', () => {
  // 0〜30 秒: 掛け合い / 30〜70 秒: 無言(移動) / 70〜100 秒: 1人で話す
  const lines = [
    line(1, 4, 'A', 'えっ？ヤバイですよね!'),
    line(4.5, 7, 'B', '無いんじゃないの マジで'),
    line(8, 12, 'A'),
    line(13, 20, 'B', 'ホントに?'),
    line(21, 29, 'A'),
    line(72, 80, 'A'),
    line(82, 95, 'A')
  ]
  const scenes = buildScenes(lines, { start: 0, end: 100 })

  it('長い無言を「会話の無い場面」として分け、場面どうしを隙間なくつなぐ', () => {
    expect(scenes.map((s) => s.lines.length)).toEqual([5, 0, 2])
    expect(scenes[0].start).toBe(0)
    expect(scenes.at(-1)!.end).toBe(100)
    for (let i = 1; i < scenes.length; i++)
      expect(scenes[i].start).toBeCloseTo(scenes[i - 1].end, 9)
    expect(scenes[1].start).toBeCloseTo(29.5, 9)
    expect(scenes[1].end).toBeCloseTo(71.5, 9)
  })

  it('簡易の点数: 掛け合いの場面は高く、無言の場面は不要', () => {
    const j = heuristicJudgements(scenes)
    expect(j[1].kind).toBe('unneeded')
    expect(j[0].score).toBeGreaterThan(j[2].score)
  })

  it('長すぎる話のまとまりは、次の切れ目で分ける', () => {
    const long = Array.from({ length: 30 }, (_, i) => line(i * 5, i * 5 + 3.5))
    const s = buildScenes(long, { start: 0, end: 150 }, { maxSceneSec: 40 })
    expect(s.length).toBeGreaterThanOrEqual(3)
    expect(s.every((x) => x.end - x.start <= 50)).toBe(true)
  })
})

describe('selectScenes', () => {
  const scenes = [
    { id: 's1', start: 0, end: 60, lines: [], speech: 40 },
    { id: 's2', start: 60, end: 120, lines: [], speech: 0 },
    { id: 's3', start: 120, end: 180, lines: [], speech: 40 },
    { id: 's4', start: 180, end: 240, lines: [], speech: 40 }
  ]
  const judgements = [
    { sceneId: 's1', score: 80, kind: 'highlight' as const, reason: '' },
    { sceneId: 's2', score: 5, kind: 'unneeded' as const, reason: '' },
    { sceneId: 's3', score: 40, kind: 'normal' as const, reason: '' },
    { sceneId: 's4', score: 60, kind: 'normal' as const, reason: '' }
  ]

  it('不要は必ず落とし、長さが余れば全部残す(時刻順)', () => {
    const r = selectScenes(scenes, judgements, 1000)
    expect(r.kept).toEqual(['s1', 's3', 's4'])
    expect(r.dropped).toEqual([{ sceneId: 's2', why: 'unneeded' }])
  })

  it('長すぎれば点数の低い場面から落とす', () => {
    const r = selectScenes(scenes, judgements, 130)
    expect(r.kept).toEqual(['s1', 's4'])
    expect(r.dropped).toContainEqual({ sceneId: 's3', why: 'length' })
    expect(r.estimated).toBe(120)
  })
})

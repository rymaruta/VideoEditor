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
    const s = buildScenes(long, { start: 0, end: 150 }, { maxSceneSec: 40, minTailSec: 0 })
    expect(s.length).toBeGreaterThanOrEqual(3)
    expect(s.every((x) => x.end - x.start <= 50)).toBe(true)
  })

  it('長さで分けた残りが短ければ、前の場面に含める(話の締めだけが別の場面にならない)', () => {
    // 0〜148.5 秒まで続く話。40 秒で分けると、最後に 135〜148.5 秒(13.5 秒)の残りができる
    const long = Array.from({ length: 30 }, (_, i) => line(i * 5, i * 5 + 3.5))
    const s = buildScenes(long, { start: 0, end: 150 }, { maxSceneSec: 40 })
    expect(s.map((x) => x.lines.length)).toEqual([9, 9, 12])
    expect(s.every((x) => x.end - x.start >= 20)).toBe(true)
    // 長い無言で分かれた所(話が終わった所)の短い場面は、そのまま残す
    const talk = [...long.slice(0, 9), line(80, 83), line(84, 88)]
    const t = buildScenes(talk, { start: 0, end: 90 }, { maxSceneSec: 40 })
    expect(t.at(-1)!.lines.map((l) => l.start)).toEqual([80, 84])
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

  it('点数が同じなら、番組の頭と終わりを残し、前後が落ちている場面から落とす', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      id: `t${i + 1}`,
      start: i * 60,
      end: (i + 1) * 60,
      lines: [],
      speech: 40
    }))
    const j = six.map((x) => ({
      sceneId: x.id,
      score: x.id === 't4' ? 5 : 70,
      kind: x.id === 't4' ? ('unneeded' as const) : ('normal' as const),
      reason: ''
    }))
    // 不要の t4 を落とした後、残りの 300 秒から 2 場面ぶん(120 秒)を削る
    const r = selectScenes(six, j, 180)
    // 以前は時刻の早い順(t1・t2)に落ち、番組の頭が消えていた。
    // 今は頭(t1)と終わり(t6)を残し、落ちた t4 の隣(t3、続いて t2 か t5)から落とす
    expect(r.kept).toContain('t1')
    expect(r.kept).toContain('t6')
    expect(r.dropped.filter((d) => d.why === 'length').map((d) => d.sceneId)[0]).toBe('t3')
    // 時間の飛ぶ所(残した場面のかたまりの数 - 1)は 1 つだけ
    const blocks = six.filter(
      (x, i) => r.kept.includes(x.id) && !(i > 0 && r.kept.includes(six[i - 1].id))
    ).length
    expect(blocks).toBe(2)
  })

  it('長すぎれば点数の低い場面から落とす', () => {
    const r = selectScenes(scenes, judgements, 130)
    expect(r.kept).toEqual(['s1', 's4'])
    expect(r.dropped).toContainEqual({ sceneId: 's3', why: 'length' })
    expect(r.estimated).toBe(120)
  })
})

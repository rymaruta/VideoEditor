import { describe, expect, it } from 'vitest'
import {
  matchScenesByTime,
  remapSceneFlags,
  remapSceneIds,
  sceneOriginsByTime
} from '@renderer/lib/pipelineRestore'
import { buildScenes, type TimedLine } from '@shared/structure/scenes'
import { TRIAL4_TRANSCRIPT } from '../shared/fixtures/trial4Transcript'

/**
 * 第4回の直しの監査の指摘 3: 保存済みの企画を開き直すと、場面をつないで1つになった今の場面が前の場面と
 * 対応せず(第4回で s1・s3・s4・s5)、保存した残す/落とすの印・判定が外れた
 */
// 前の版(0f27f36)で第4回の文字起こしを分けた 9 場面
const OLD = [
  { id: 's1', start: 0, end: 28.93 },
  { id: 's2', start: 28.93, end: 96.34 },
  { id: 's3', start: 96.34, end: 219.81 },
  { id: 's4', start: 219.81, end: 326.07 },
  { id: 's5', start: 326.07, end: 428.88 },
  { id: 's6', start: 428.88, end: 436.91 },
  { id: 's7', start: 436.91, end: 527.18 },
  { id: 's8', start: 527.18, end: 535.87 },
  { id: 's9', start: 535.87, end: 660 }
]
const now = (): { id: string; start: number; end: number }[] => {
  const lines: TimedLine[] = TRIAL4_TRANSCRIPT.map(([start, end, text], i) => ({
    id: `u${i}`,
    speaker: 'マイク1',
    start,
    end,
    text,
    overlap: false
  }))
  return buildScenes(lines, { start: 0, end: 660 })
}

describe('前の 9 場面 → 今の場面', () => {
  it('今の場面のどれもが前の場面を元に持ち、前の場面の印がどれも今のどれかへ移る', () => {
    const next = now()
    expect(next.length).toBeLessThan(OLD.length)
    const origins = sceneOriginsByTime(OLD, next)
    for (const n of next) expect(origins.get(n.id), n.id).toBeDefined()
    const from = new Set([...origins.values()].flat())
    for (const o of OLD) expect(from.has(o.id), o.id).toBe(true)
    // 印: 前の場面の残す/落とすが、今の場面へ全部移る
    const flags = Object.fromEntries(OLD.map((o, i) => [o.id, i % 3 !== 2]))
    const keep = remapSceneFlags(flags, matchScenesByTime(OLD, next), origins)
    expect(Object.keys(keep).sort()).toEqual(next.map((n) => n.id).sort())
    // 残した場面の記録も移る
    expect(remapSceneIds(['s8'], origins)).toHaveLength(1)
  })

  it('いくつも含む今の場面: 印が全部同じならそれ、違えば残す側。判定は重なりの最も大きい前の場面', () => {
    const prev = [
      { id: 'a', start: 0, end: 30 },
      { id: 'b', start: 30, end: 90 },
      { id: 'c', start: 90, end: 100 }
    ]
    const next = [{ id: 'n1', start: 0, end: 100 }]
    const origins = sceneOriginsByTime(prev, next)
    expect(origins.get('n1')).toEqual(['b', 'a', 'c'])
    const m = matchScenesByTime(prev, next)
    expect(m.get('n1')).toBe('b')
    expect(remapSceneFlags({ a: false, b: false, c: false }, m, origins)).toEqual({ n1: false })
    expect(remapSceneFlags({ a: false, b: true, c: false }, m, origins)).toEqual({ n1: true })
    expect(remapSceneFlags({ a: true, b: true, c: true }, m, origins)).toEqual({ n1: true })
  })
})

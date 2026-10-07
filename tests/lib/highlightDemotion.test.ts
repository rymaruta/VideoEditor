import { describe, expect, it } from 'vitest'
import { planRoughCut, type RoughCutPlan } from '../../src/renderer/src/lib/roughCutPlan'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Project } from '@shared/types'
import {
  demoteIndiscriminateHighlights,
  type Scene,
  type SceneJudgement
} from '@shared/structure/scenes'
import { TURN_RATE } from '@shared/diarize/micTurns'

/**
 * 「見どころ」がほとんどの場面に付いた判定(見分けになっていない)の扱い。
 * 置き換えるのは、点数の下限で残す場面を決めるとき(「面白い所だけ」・長さの目標なし)だけ。
 * 作り直し(判定を作り直さない)でも、方針・目標に合わせてその場で決まる
 */

const N = 8
const LEN = 30
const info: MulticamInfo = {
  anchorSourceId: 'cam',
  sources: [
    { id: 'cam', name: 'カメラ', kind: 'camera' },
    { id: 'mic', name: '実況', kind: 'mic' }
  ],
  files: [
    { assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: N * LEN },
    { assetId: 'M', sourceId: 'mic', start: 0, rate: 1, duration: N * LEN }
  ]
}
const project = { aspectRatio: '16:9', transcript: [] } as unknown as Project
const scenes: Scene[] = Array.from({ length: N }, (_, i) => ({
  id: `s${i}`,
  start: i * LEN,
  end: i * LEN + LEN,
  lines: [
    {
      id: `l${i}`,
      start: i * LEN + 2,
      end: i * LEN + 8,
      text: 'あ',
      speaker: '実況',
      overlap: false
    }
  ],
  speech: 6,
  hype: i === 3 ? 3 : 0
}))
const ai = (kinds: SceneJudgement['kind'][]): SceneJudgement[] =>
  scenes.map((s, i) => ({
    sceneId: s.id,
    score: 80,
    kind: kinds[i],
    reason: 'AI',
    title: `題${i}`
  }))
const activity = (() => {
  const a = new Uint8Array(N * LEN * TURN_RATE)
  for (const s of scenes) a.fill(1, (s.start + 2) * TURN_RATE, (s.start + 8) * TURN_RATE)
  return a
})()
const plan = (
  judgements: SceneJudgement[],
  o: { policy: 'highlights' | 'tempo'; targetSec: number }
): RoughCutPlan =>
  planRoughCut(project, info, scenes, judgements, activity, {
    styles: [],
    kind: 'game',
    ...o
  })

describe('見分けになっていない「見どころ」', () => {
  it('半分を超える場面が見どころなら、印と点数を点数の判定に置き換える(題・不要の印はそのまま)', () => {
    const heuristic = scenes.map((s, i) => ({
      sceneId: s.id,
      score: i === 3 ? 70 : 30,
      kind: (i === 3 ? 'highlight' : i === 5 ? 'unneeded' : 'normal') as SceneJudgement['kind'],
      reason: 'h'
    }))
    const kinds = Array.from({ length: N }, (_, i) =>
      i === 7 ? 'unneeded' : 'highlight'
    ) as SceneJudgement['kind'][]
    const r = demoteIndiscriminateHighlights(ai(kinds), heuristic)
    expect(r.demoted).toEqual({ highlights: 7, total: 8 })
    expect(r.judgements[3]).toMatchObject({ kind: 'highlight', score: 70, title: '題3' })
    // 置き換えで「不要」にはしない。AI の「不要」はそのまま
    expect(r.judgements[5].kind).toBe('normal')
    expect(r.judgements[7].kind).toBe('unneeded')
    // 少数なら何もしない
    const few = ai([
      'highlight',
      'highlight',
      'normal',
      'normal',
      'normal',
      'normal',
      'normal',
      'normal'
    ])
    expect(demoteIndiscriminateHighlights(few, heuristic).demoted).toBeUndefined()
    // 判定がもともと点数の判定なら、置き換えても変わらないので「選び直した」としない
    const heurAll = heuristic.map((h) => ({ ...h, kind: 'highlight' as const }))
    expect(demoteIndiscriminateHighlights(heurAll, heurAll).demoted).toBeUndefined()
  })

  it('「面白い所だけ」・目標なしの仮編集では置き換え、山のある場面を残す。方針や目標を替えると置き換えない', () => {
    const all = ai(Array.from({ length: N }, () => 'highlight'))
    const h = plan(all, { policy: 'highlights', targetSec: 0 })
    expect(h.demoted).toEqual({ highlights: 8, total: 8 })
    // 構成の画面に見せる判定も、選ぶのに使った判定
    expect(h.judgements.filter((j) => j.kind === 'highlight').length).toBeLessThan(N)
    expect(h.selection.kept).toContain('s3')
    expect(h.selection.kept.length).toBeLessThan(N)
    const t = plan(all, { policy: 'tempo', targetSec: 0 })
    expect(t.demoted).toBeUndefined()
    expect(t.selection.kept).toHaveLength(N)
  })
})

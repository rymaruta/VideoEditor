import { describe, expect, it } from 'vitest'
import { planRoughCut } from '../../src/renderer/src/lib/roughCutPlan'
import { droppedSceneReason, dropPolicyOf } from '@renderer/lib/autoEditView'
import { normalizeDropBasis } from '@shared/autoEdit'
import { selectScenes, type Scene, type SceneJudgement } from '@shared/structure/scenes'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Project } from '@shared/types'
import { TURN_RATE } from '@shared/diarize/micTurns'

/**
 * 試し編集 第4回 N3: 仮編集を組むとき(planRoughCut)に落とした場面の一覧を作り直し、決め手(`by`)を捨てていた
 * ので `dropBasis.lengthBy` が保存されず、落とした理由の文が推測になっていた。また、55 点の s7 を「点数の低い
 * 場面から」落としたと出ながら、より低い 50 点の s8(9 秒)が残っていた(点数の低い順に落とした後、短い s8 は
 * 戻しても目標に収まるので戻した)。実際の決め手を書く
 */
const scene = (id: string, start: number, dur: number): Scene => ({
  id,
  start,
  end: start + dur,
  speech: dur * 0.8,
  lines: [
    { id: `${id}-l`, speaker: 'マイク1', start, end: start + 1, text: 'はい', overlap: false }
  ]
})

describe('第4回の場面(9 場面に時刻順で 85→45 点)', () => {
  // 第4回の場面の長さ(秒)
  const lengths = [29, 67, 123, 106, 103, 8, 90, 9, 124]
  let t = 0
  const scenes = lengths.map((d, i) => {
    const s = scene(`s${i + 1}`, t, d)
    t += d
    return s
  })
  const judgements: SceneJudgement[] = scenes.map((s, i) => ({
    sceneId: s.id,
    score: 85 - i * 5,
    kind: 'highlight',
    reason: ''
  }))

  it('より低い場面を戻したら、落とした場面の決め手は「点数」だけではない(refit)', () => {
    const r = selectScenes(scenes, judgements, 450)
    expect(r.kept).toContain('s8')
    const by = Object.fromEntries(r.dropped.map((d) => [d.sceneId, d.by]))
    expect(by).toEqual({ s7: 'refit', s9: 'score' })
  })

  it('落とした理由の文: 戻した、より低い短い場面を書く(「点数の低い場面から」だけで終わらない)', () => {
    const r = selectScenes(scenes, judgements, 450)
    const kept = scenes.filter((s) => r.kept.includes(s.id))
    const policy = dropPolicyOf('tempo', 7.5)
    const s7 = droppedSceneReason(
      scenes[6],
      judgements[6],
      judgements,
      false,
      policy,
      kept,
      'refit'
    )
    expect(s7).toContain('55 点')
    expect(s7).toContain('より点の低い場面(50 点 · 9 秒)')
    expect(s7).toContain('戻しても目標の長さに収まる')
    // 決め手は企画に覚える
    expect(
      normalizeDropBasis({
        dropUnneeded: true,
        targetSec: 450,
        minScore: null,
        relaxed: false,
        replaced: false,
        lengthBy: { s7: 'refit' }
      })?.lengthBy
    ).toEqual({ s7: 'refit' })
  })
})

describe('仮編集を組むとき(planRoughCut)も決め手を残す', () => {
  const N = 6
  const LEN = 30
  const info: MulticamInfo = {
    anchorSourceId: 'cam',
    sources: [
      { id: 'cam', name: 'カメラ', kind: 'camera' },
      { id: 'mic', name: 'マイク', kind: 'mic' }
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
        end: i * LEN + 20,
        text: 'あ',
        speaker: 'マイク',
        overlap: false
      }
    ],
    speech: 18
  }))
  const judgements: SceneJudgement[] = scenes.map((s, i) => ({
    sceneId: s.id,
    score: i === 2 ? 40 : 80,
    kind: 'highlight',
    reason: ''
  }))
  const activity = (() => {
    const a = new Uint8Array(N * LEN * TURN_RATE)
    for (const s of scenes) a.fill(1, (s.start + 2) * TURN_RATE, (s.start + 20) * TURN_RATE)
    return a
  })()

  it('長さで落とした場面の by が plan.selection.dropped に残る', () => {
    const plan = planRoughCut(project, info, scenes, judgements, activity, {
      styles: [],
      kind: 'location',
      policy: 'tempo',
      targetSec: 60
    })
    const length = plan.selection.dropped.filter((d) => d.why === 'length')
    expect(length.length).toBeGreaterThan(0)
    expect(length.find((d) => d.sceneId === 's2')?.by).toBe('score')
    for (const d of length) expect(d.by).toBeDefined()
  })

  it('手で落とした場面には、自動の決め手を付けない', () => {
    const plan = planRoughCut(project, info, scenes, judgements, activity, {
      styles: [],
      kind: 'location',
      policy: 'tempo',
      targetSec: 1000,
      keep: { s0: false }
    })
    const d = plan.selection.dropped.find((x) => x.sceneId === 's0')
    expect(d).toBeDefined()
    expect(d?.by).toBeUndefined()
  })
})

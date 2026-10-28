import { describe, expect, it } from 'vitest'
import { autoKeptScenes, planRoughCut } from '../../src/renderer/src/lib/roughCutPlan'
import { buildReviewItems, structureRescueOf } from '../../src/renderer/src/lib/reviewItems'
import { buildStructurePrompt } from '@shared/structure/llm'
import { selectScenes, type Scene, type SceneJudgement } from '@shared/structure/scenes'
import { TURN_RATE } from '@shared/diarize/micTurns'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Project } from '@shared/types'

/**
 * 構成の判定が全部の場面を「不要」にしたとき(試し編集の回: 話し声でない素材で文字起こしが「2」「ん」だけに
 * なり、このPCの AI が 7 場面すべてを「無題・0 点・不要」にした)、自動編集がカットで
 * 「残す場面がありません」と止まっていた。点数・発話の割合の上位を仮に残し、要確認で知らせる。
 * 人が手で全部を外したときは、仮に残さない(人の決めたことを上書きしない)。
 */

const line = (id: string, start: number, end: number, text: string): Scene['lines'][number] => ({
  id,
  speaker: 'マイク1',
  start,
  end,
  text,
  overlap: false
})

// 試し編集の回の場面と同じ並び(発話の割合 0% / 85% / 0% / 78% / 0% / 47% / 0%)
const scenes: Scene[] = [
  { id: 's1', start: 0, end: 40, lines: [], speech: 0 },
  { id: 's2', start: 40, end: 70, lines: [line('a', 41, 66.5, '2 2')], speech: 25.5 },
  { id: 's3', start: 70, end: 100, lines: [], speech: 0 },
  { id: 's4', start: 100, end: 130, lines: [line('b', 101, 124.4, 'んん')], speech: 23.4 },
  { id: 's5', start: 130, end: 400, lines: [], speech: 0 },
  { id: 's6', start: 400, end: 430, lines: [line('c', 401, 415.1, 'ん')], speech: 14.1 },
  { id: 's7', start: 430, end: 550, lines: [], speech: 0 }
]
const allUnneeded: SceneJudgement[] = scenes.map((s) => ({
  sceneId: s.id,
  score: 0,
  kind: 'unneeded',
  title: '無題',
  reason: '無題の場面は、収録の一部として残す価値が低い。'
}))

describe('全部の場面が「不要」の判定', () => {
  it('点数・発話の割合の上位(話している場面)を仮に残し、仮に残したことを返す', () => {
    const r = selectScenes(scenes, allUnneeded, Infinity)
    expect(r.kept).toEqual(['s2', 's4', 's6'])
    expect(r.rescued).toEqual({ kept: 3, total: 7 })
  })

  it('点数に差があれば点数を先に見る。話している場面が無ければ、いちばん上の 1 場面だけ残す', () => {
    const quiet = scenes.map((s) => ({ ...s, lines: [], speech: 0 }))
    const j = allUnneeded.map((x) => (x.sceneId === 's5' ? { ...x, score: 12 } : x))
    const r = selectScenes(quiet, j, Infinity)
    expect(r.kept).toEqual(['s5'])
    expect(r.rescued).toEqual({ kept: 1, total: 7 })
  })

  it('「面白い所だけ」(点数の下限)・長さの目標があっても空にしない', () => {
    expect(selectScenes(scenes, allUnneeded, Infinity, undefined, 50).kept).toEqual([
      's2',
      's4',
      's6'
    ])
    // 長さの目標(60 秒)に収まるまで落とす。点数が同じなので頭と終わりを残す
    const short = selectScenes(scenes, allUnneeded, 60)
    expect(short.kept.length).toBeGreaterThan(0)
    expect(short.rescued).toBeDefined()
  })

  it('一部だけ「不要」なら今までどおり(仮に残すのは全部が「不要」のときだけ)', () => {
    const j = allUnneeded.map((x) => (x.sceneId === 's1' ? { ...x, kind: 'normal' as const } : x))
    const r = selectScenes(scenes, j, Infinity)
    expect(r.kept).toEqual(['s1'])
    expect(r.rescued).toBeUndefined()
  })

  it('「軽く整える」(不要を落とさない)は全部を残す', () => {
    const r = selectScenes(scenes, allUnneeded, Infinity, undefined, -Infinity, false)
    expect(r.kept).toEqual(scenes.map((s) => s.id))
    expect(r.rescued).toBeUndefined()
  })

  it('自動編集の場面の選び方(ロケ・テンポよく)でも、空の仮編集にしない', () => {
    expect(autoKeptScenes(scenes, allUnneeded, 'location')).toEqual(['s2', 's4', 's6'])
  })
})

describe('仮編集(planRoughCut)', () => {
  const info: MulticamInfo = {
    anchorSourceId: 'cam',
    sources: [
      { id: 'cam', name: 'カメラA', kind: 'camera' },
      { id: 'mic', name: 'マイク1', kind: 'mic' }
    ],
    files: [
      { assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: 550 },
      { assetId: 'M', sourceId: 'mic', start: 0, rate: 1, duration: 550 }
    ]
  }
  const project = { aspectRatio: '16:9', transcript: [] } as unknown as Project
  const activity = new Uint8Array(550 * TURN_RATE).fill(1)

  it('判定が全部「不要」でも残す区間があり、仮に残したことを知らせる', () => {
    const plan = planRoughCut(project, info, scenes, allUnneeded, activity, {
      targetSec: 0,
      styles: []
    })
    expect(plan.cut.main.length).toBeGreaterThan(0)
    expect(plan.selection.kept).toEqual(['s2', 's4', 's6'])
    expect(plan.selection.rescued).toEqual({ kept: 3, total: 7 })
  })

  it('人が手で全部を外したら仮に残さない(人の決めたことを上書きしない)', () => {
    const keep = Object.fromEntries(scenes.map((s) => [s.id, false]))
    const plan = planRoughCut(project, info, scenes, allUnneeded, activity, {
      targetSec: 0,
      styles: [],
      keep
    })
    expect(plan.selection.kept).toEqual([])
    expect(plan.cut.main.length).toBe(0)
  })
})

describe('要確認', () => {
  it('全部「不要」の判定で仮に残した場面があれば、要確認に「構成」の項目を出す', () => {
    const rescue = structureRescueOf(allUnneeded, ['s2', 's4', 's6'], {})
    expect(rescue).toEqual({ kept: 3, total: 7 })
    const items = buildReviewItems({
      project: {
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [],
        clips: [],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: []
      },
      syncIssues: [],
      fileLabel: () => '',
      placedStart: () => undefined,
      telopReviews: [],
      colorIssues: [],
      denoiseFailures: [],
      effects: [],
      effectChosen: [],
      qc: null,
      structureRescue: rescue
    })
    const item = items.find((i) => i.key === 'structure-rescued')
    expect(item?.tab).toBe('structure')
    expect(item?.text).toContain('全 7 場面を「不要」')
    expect(item?.text).toContain('3 場面を仮に残しました')
  })

  it('手で残す/落とすを決めた・一部だけ不要・残す場面が無いときは出さない', () => {
    expect(structureRescueOf(allUnneeded, ['s2'], { s2: true })).toBeNull()
    expect(
      structureRescueOf(
        allUnneeded.map((j, i) => (i === 0 ? { ...j, kind: 'normal' } : j)),
        ['s1'],
        {}
      )
    ).toBeNull()
    expect(structureRescueOf(allUnneeded, [], {})).toBeNull()
  })
})

describe('AI への頼み方', () => {
  it('場面ごとの発話の割合を渡し、場面どうしを比べて点数に差を付けるよう頼む', () => {
    const p = buildStructurePrompt(scenes, 550, { episodeName: '試し', targetSec: 550 })
    expect(p).toContain('[s2] 0:00:40〜0:01:10 マイク1「2 2」(発話85%)')
    // 話していない場面は今までどおり「会話なし」
    expect(p).toContain('[s1] 0:00:00〜0:00:40 (会話なし)')
    expect(p).toContain('場面どうしを比べて、点数に差を付けてください')
    expect(p).toContain('「発話○%」(話している長さの割合)と笑いの回数でも比べてください')
    const game = buildStructurePrompt(scenes, 550, {
      episodeName: '試し',
      targetSec: 0,
      kind: 'game'
    })
    expect(game).toContain('場面どうしを比べて、点数に差を付けてください')
  })
})

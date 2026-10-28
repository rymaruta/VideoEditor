import { describe, expect, it } from 'vitest'
import { buildReviewItems, structureIndistinctOf } from '@renderer/lib/reviewItems'
import { droppedSceneReason, dropPolicyOf, type DropPolicy } from '@renderer/lib/autoEditView'
import type { Scene, SceneJudgement } from '@shared/structure/scenes'
import type { Project } from '@shared/types'

/**
 * 試し編集 第2回の不具合 2: 構成の AI が全 9 場面に同じ「見どころ・85 点」を付け、長さに合わせて 2 場面を落とした
 * のに、要確認は 0 件、構成の画面でも落とした行は「見どころ」の印のままチェックが外れているだけだった
 */
const project = {
  id: 'p',
  name: 'p',
  aspectRatio: '16:9',
  assets: [],
  clips: [],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: []
} as unknown as Project

const judgements: SceneJudgement[] = Array.from({ length: 9 }, (_, i) => ({
  sceneId: `s${i + 1}`,
  score: 85,
  kind: 'highlight',
  reason: '文字起こしの言い換え'
}))
const kept = ['s1', 's4', 's5', 's6', 's7', 's8', 's9']
/** 仕上がり 8 分・テンポよく(試し編集 第2回の設定) */
const POLICY: DropPolicy = dropPolicyOf('tempo', 8)

const sources = (
  indistinct: ReturnType<typeof structureIndistinctOf>
): Parameters<typeof buildReviewItems>[0] => ({
  project,
  syncIssues: [],
  fileLabel: (id) => id,
  placedStart: () => undefined,
  telopReviews: [],
  colorIssues: [],
  denoiseFailures: [],
  effects: [],
  effectChosen: [],
  qc: null,
  structureIndistinct: indistinct
})

describe('構成の判定が場面を区別できていないことを知らせる', () => {
  it('要確認に「全部に同じ点を付けた」「長さで落とした場面は中身の手掛かりで選んだ」を出す', () => {
    const x = structureIndistinctOf(judgements, null, kept, {}, POLICY, 'ai')
    expect(x).toEqual({
      total: 9,
      score: 85,
      kind: 'highlight',
      droppedByLength: 2,
      source: 'ai',
      replaced: false
    })
    const items = buildReviewItems(sources(x))
    const item = items.find((i) => i.key === 'structure-indistinct')
    expect(item?.area).toBe('structure')
    expect(item?.tab).toBe('structure')
    expect(item?.text).toContain('9 場面すべてに同じ点(85 点・見どころ)')
    expect(item?.text).toContain('落とした 2 場面')
  })

  it('点数に差があれば出さない', () => {
    const varied = judgements.map((j, i) => ({ ...j, score: 50 + i * 5 }))
    expect(structureIndistinctOf(varied, null, kept, {}, POLICY, 'ai')).toBeNull()
  })

  it('落とした場面に、落とした理由(長さ・中身の手掛かり)を出す', () => {
    const scene: Scene = {
      id: 's2',
      start: 29,
      end: 96,
      speech: 50,
      lines: [
        {
          id: 'l1',
          speaker: 'マイク1',
          start: 41,
          end: 50,
          text: '今年2024年は社員1人当たり5%の賃上げ',
          overlap: false
        }
      ]
    }
    const why = droppedSceneReason(scene, judgements[1], judgements, false, POLICY)
    expect(why).toContain('長さに合わせて')
    expect(why).toContain('同じ点(85 点)')
    expect(why).toMatch(/数字 \d/)
    expect(droppedSceneReason(scene, judgements[1], judgements, true, POLICY)).toBe(
      '手で落としました'
    )
    expect(
      droppedSceneReason(scene, { ...judgements[1], kind: 'unneeded' }, judgements, false, POLICY)
    ).toContain('不要')
  })
})

describe('落とした場面の数と理由を、実際の選び方に合わせる(監査 D2)', () => {
  it('手で落とした場面は「長さに合わせて落とした」に数えない', () => {
    const x = structureIndistinctOf(judgements, null, kept, { s3: false }, POLICY, 'ai')
    expect(x?.droppedByLength).toBe(1)
  })

  it('目標の長さが無い「面白い所だけ」で落ちた場面は、点数の下限で落ちたと書く', () => {
    const policy = dropPolicyOf('highlights', 0)
    const plan = judgements.map((j, i) =>
      i === 1 ? { ...j, kind: 'normal' as const, score: 30 } : j
    )
    const scene: Scene = { id: 's2', start: 0, end: 60, speech: 30, lines: [] }
    const why = droppedSceneReason(scene, plan[1], plan, false, policy)
    expect(why).toContain('下限(50 点)')
    expect(why).not.toContain('長さ')
    expect(structureIndistinctOf(judgements, plan, kept, {}, policy, 'ai')?.droppedByLength).toBe(0)
  })

  it('見どころを点数の判定に置き換えた回は、置き換えた判定で選んだと書く', () => {
    const plan = judgements.map((j, i) => ({ ...j, score: 40 + i * 5, kind: 'normal' as const }))
    const x = structureIndistinctOf(judgements, plan, kept, {}, POLICY, 'ai')!
    expect(x.replaced).toBe(true)
    const text = buildReviewItems(sources(x)).find((i) => i.key === 'structure-indistinct')!.text
    expect(text).toContain('声の盛り上がり・笑い・発話の密度の点数で選びました')
  })
})

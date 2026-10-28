import { describe, expect, it } from 'vitest'
import { buildReviewItems, structureIndistinctOf } from '@renderer/lib/reviewItems'
import { droppedSceneReason, dropPolicyOf, type DropPolicy } from '@renderer/lib/autoEditView'
import { sceneSubstance, type Scene, type SceneJudgement } from '@shared/structure/scenes'
import type { Project } from '@shared/types'

/**
 * 試し編集 第3回の N2・N3: AI が s2 だけ 80 点・残り 8 場面に 85 点を付けた(ほぼ同点)。落とした s3(85 点)に
 * 「点数の低い場面から落としました」と出て、要確認(区別できていない)も出なかった。全部同点で作り直したときの
 * 理由は「中身の手掛かりの少ない場面から」なのに、数は固有名詞 21 と多く見えた
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

const POLICY: DropPolicy = dropPolicyOf('tempo', 8)
const judgements: SceneJudgement[] = Array.from({ length: 9 }, (_, i) => ({
  sceneId: `s${i + 1}`,
  score: i === 1 ? 80 : 85,
  kind: 'highlight',
  reason: ''
}))
const keptIds = ['s1', 's4', 's5', 's6', 's7', 's8', 's9']

const line = (id: string, start: number, text: string): Scene['lines'][number] => ({
  id,
  speaker: 'マイク1',
  start,
  end: start + 8,
  text,
  overlap: false
})
const scene = (id: string, start: number, texts: string[]): Scene => ({
  id,
  start,
  end: start + 60,
  speech: texts.length * 8,
  lines: texts.map((t, i) => line(`${id}-${i}`, start + i * 10, t))
})
const scenes: Scene[] = [
  scene('s1', 0, ['今年2024年は5%の賃上げ', '日立建機さんと30社']),
  scene('s2', 60, ['物価が10%上がりました']),
  scene('s3', 120, ['そうですね', 'いろいろありまして']),
  scene('s4', 180, ['2年前に3%上げました', 'パートさんも2%']),
  scene('s5', 240, ['東原原本部は明治43年に', '両国亀沢の地で114年目']),
  scene('s6', 300, ['10%の値上げを2回']),
  scene('s7', 360, ['ロイヤルカスタマーを3割増やす']),
  scene('s8', 420, ['5回の対面式の打ち合わせ']),
  scene('s9', 480, ['2023年以降は通常に戻りました'])
]
const kept = scenes.filter((s) => keptIds.includes(s.id))

describe('ほぼ同点のときの要確認と落とした理由(N2)', () => {
  it('9 場面中 8 場面が同じ点でも要確認を出し、点数で落とした場面は数えない', () => {
    const x = structureIndistinctOf(judgements, null, keptIds, {}, POLICY, 'ai')
    expect(x).toMatchObject({ total: 8, of: 9, score: 85, droppedByLength: 1 })
    const items = buildReviewItems({
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
      structureIndistinct: x
    })
    const text = items.find((i) => i.key === 'structure-indistinct')!.text
    expect(text).toContain('9 場面中 8 場面に同じ点(85 点・見どころ)')
    expect(text).toContain('落とした 1 場面')
  })

  it('同じ点の場面を残して落とした場面は「同じ点の中で」、点数が低くて落とした場面は「点数の低い場面から」', () => {
    const s3 = droppedSceneReason(scenes[2], judgements[2], judgements, false, POLICY, kept)
    expect(s3).toContain('同じ点(85 点)の場面の中で')
    expect(s3).not.toContain('点数の低い場面から')
    const s2 = droppedSceneReason(scenes[1], judgements[1], judgements, false, POLICY, kept)
    expect(s2).toContain('点数の低い場面から')
  })

  it('理由の数は、選んだ決め手(1分あたりの手掛かりの点)と残した同じ点の場面の点を並べて書く(N3)', () => {
    const why = droppedSceneReason(scenes[2], judgements[2], judgements, false, POLICY, kept)
    const mine = Math.round(sceneSubstance(scenes[2]))
    const others = kept.map((s) => Math.round(sceneSubstance(s)))
    expect(why).toContain(`手掛かり ${mine}`)
    expect(why).toContain(`残した同じ点の場面は ${Math.min(...others)}〜${Math.max(...others)}`)
    expect(mine).toBeLessThanOrEqual(Math.min(...others))
  })
})

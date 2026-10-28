import { describe, expect, it } from 'vitest'
import { droppedSceneReason, dropPolicyOf } from '@renderer/lib/autoEditView'
import { verticalSampleKey } from '@renderer/lib/verticalFraming'
import { normalizeDropBasis } from '@shared/autoEdit'
import { selectScenes, type Scene, type SceneJudgement } from '@shared/structure/scenes'
import type { Project } from '@shared/types'

/**
 * 監査の指摘 7: 落とした理由の文を実際の選び方(番組の頭・終わり・前後が落ちている・目標の長さに近い)に
 * 合わせる。見本の鍵に話者・文字起こしの指紋を入れる
 */
let n = 0
const scene = (id: string, start: number, dur: number, texts: string[]): Scene => ({
  id,
  start,
  end: start + dur,
  speech: dur * 0.8,
  lines: texts.map((text, i) => ({
    id: `${id}-${++n}`,
    speaker: 'マイク1',
    start: start + i,
    end: start + i + 0.8,
    text,
    overlap: false
  }))
})
const judge = (ids: string[], score: (id: string) => number = () => 85): SceneJudgement[] =>
  ids.map((sceneId) => ({ sceneId, score: score(sceneId), kind: 'highlight', reason: '' }))

describe('長さで落とした場面の決め手', () => {
  const scenes = [
    scene('s1', 0, 60, ['今年2024年は5%の賃上げ', '日立建機さん30社']),
    scene('s2', 60, 60, ['物価が10%上がりました']),
    scene('s3', 120, 60, ['そうですね']),
    scene('s4', 180, 60, ['2年前に3%上げました', 'パートさんも2%']),
    scene('s5', 240, 25, ['そうですね', 'いろいろ']),
    scene('s6', 265, 60, ['2023年以降は通常に戻りました'])
  ]
  const total = scenes.reduce((t, s) => t + s.end - s.start, 0)

  it('点数がいちばん低い場面は score、同じ点の中は cues、目標に近づけた場面は fit', () => {
    const j = judge(
      scenes.map((s) => s.id),
      (id) => (id === 's2' ? 80 : 85)
    )
    const r = selectScenes(scenes, j, total - 100)
    const by = Object.fromEntries(r.dropped.map((d) => [d.sceneId, d.by]))
    expect(by.s2).toBe('score')
    expect(Object.values(by).every((b) => b !== undefined)).toBe(true)
    const fit = selectScenes(scenes, judge(scenes.map((s) => s.id)), total - 20)
    // 1 つ落とせば収まる: 手掛かりのいちばん少ない s3(60 秒)ではなく、目標に近い s5(25 秒)
    expect(fit.dropped).toEqual([{ sceneId: 's5', why: 'length', by: 'fit' }])
  })

  it('落とした理由の文は、決め手に合わせる', () => {
    const j = judge(scenes.map((s) => s.id))
    const policy = dropPolicyOf('tempo', 8)
    const kept = scenes.filter((s) => s.id !== 's5')
    const fit = droppedSceneReason(scenes[4], j[4], j, false, policy, kept, 'fit')
    expect(fit).toContain('目標の長さにいちばん近くなる')
    expect(fit).not.toContain('手掛かり')
    expect(droppedSceneReason(scenes[4], j[4], j, false, policy, kept, 'beside')).toContain(
      '前後の場面がすでに落ちている'
    )
    expect(droppedSceneReason(scenes[4], j[4], j, false, policy, kept, 'cues')).toContain(
      '中身の手掛かり'
    )
  })

  it('決め手は企画に覚える(壊れた値は捨てる)', () => {
    const basis = normalizeDropBasis({
      dropUnneeded: true,
      targetSec: 480,
      minScore: null,
      relaxed: false,
      replaced: false,
      lengthBy: { s3: 'cues', s5: 'fit', s9: 'nonsense' }
    })
    expect(basis?.lengthBy).toEqual({ s3: 'cues', s5: 'fit' })
  })
})

describe('書き出し画面の見本の鍵', () => {
  it('話者を直したら別の鍵(話す人への切り替えが変わる)', () => {
    const p = {
      id: 'p',
      clips: [{ id: 'c1', assetId: 'A', inPoint: 0, outPoint: 30, speed: 1 }],
      transcript: [
        {
          id: 'u1',
          assetId: 'A',
          speaker: '山田',
          sourceStart: 0,
          sourceEnd: 5,
          text: 'a',
          words: [],
          overlap: false
        }
      ]
    } as unknown as Project
    const k = verticalSampleKey(p, [1, 10], true, true)
    const renamed = {
      ...p,
      transcript: [{ ...p.transcript![0], speaker: '佐藤' }]
    } as Project
    expect(verticalSampleKey(renamed, [1, 10], true, true)).not.toBe(k)
    expect(verticalSampleKey(p, [1, 10], true, true)).toBe(k)
  })
})

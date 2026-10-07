import { describe, expect, it } from 'vitest'
import { planRoughCut } from '../../src/renderer/src/lib/roughCutPlan'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Project } from '@shared/types'
import type { Scene, SceneJudgement } from '@shared/structure/scenes'
import { TURN_RATE } from '@shared/diarize/micTurns'
import type { ShowStyle } from '@shared/style/showStyle'
import { FIRST_TELOP_DELAY_SEC } from '@shared/telop/fromTranscript'
import { defaultTextStyle } from '@shared/textStyle'

// カメラ1台・マイク1本、どちらも共通の時刻 = 素材の時刻
const info: MulticamInfo = {
  anchorSourceId: 'cam',
  sources: [
    { id: 'cam', name: 'カメラA', kind: 'camera' },
    { id: 'mic', name: '出演者A', kind: 'mic' }
  ],
  files: [
    { assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: 30 },
    { assetId: 'M', sourceId: 'mic', start: 0, rate: 1, duration: 30 }
  ]
}

const utt = (id: string, start: number, end: number, text: string): unknown => ({
  id,
  assetId: 'M',
  speaker: '出演者A',
  sourceStart: start,
  sourceEnd: end,
  text,
  words: [{ text, start: start + 0.4, end }],
  overlap: false
})

describe('planRoughCut — カット点とテロップの時刻', () => {
  // 1〜4 秒と 6〜9 秒に発話。間の 2 秒は詰める(絵として残す長さには届かない)。4.20〜4.26 秒に語尾の短い音
  const project = {
    aspectRatio: '16:9',
    transcript: [utt('u1', 1, 4, 'こんにちは'), utt('u2', 6, 9, 'よろしくお願いします')]
  } as unknown as Project
  const n = 30 * TURN_RATE
  const activity = new Uint8Array(n)
  activity.fill(1, 100, 400)
  activity.fill(1, 600, 900)
  const level = new Float32Array(n).fill(-56)
  level.fill(-15, 100, 400)
  level.fill(-14, 420, 426)
  level.fill(-15, 600, 900)
  // 間を 0.46 秒残す番組(前後に 0.23 秒ずつ)。切る位置がちょうど短い音に掛かる
  const wideKeep = { keepPauseSec: 0.46, maxPauseSec: 0.7 } as unknown as ShowStyle
  const scenes: Scene[] = [{ id: 's1', start: 0, end: 30, lines: [], speech: 6 }]
  const judgements: SceneJudgement[] = [{ sceneId: 's1', score: 80, kind: 'normal', reason: '' }]

  it('間を詰めた切れ目を、語尾の短い音の後の静かな所へ寄せる', () => {
    const before = planRoughCut(project, info, scenes, judgements, activity, {
      targetSec: 0,
      styles: [],
      style: wideKeep
    })
    // 寄せる前は 4.23 秒(短い音の途中)で切れる
    expect(before.pieces[0].end).toBeCloseTo(4.23, 6)
    const plan = planRoughCut(project, info, scenes, judgements, activity, {
      targetSec: 0,
      styles: [],
      style: wideKeep,
      level
    })
    expect(plan.pieces[0].end).toBeGreaterThanOrEqual(4.26)
    expect(level[Math.floor(plan.pieces[0].end * TURN_RATE)]).toBeLessThanOrEqual(-50)
  })

  it('発言テロップは発話の頭から出し、切れ目の直後のテロップは切れ目から出す', () => {
    const plan = planRoughCut(project, info, scenes, judgements, activity, {
      targetSec: 0,
      styles: [],
      level
    })
    const [a, b] = plan.telops
    // 言葉の時刻(1.4 秒)ではなく、発話の頭の少し後
    expect(a.startTime).toBeCloseTo(1 - plan.pieces[0].start + FIRST_TELOP_DELAY_SEC, 6)
    // 2つ目は切れ目(タイムラインで2つ目の区間の頭)から
    expect(b.startTime).toBeCloseTo(plan.cut.spans[1].timeline, 6)
  })
  it('発言テロップは、選んだ見た目(自分で作ったスタイル)で入る。話者に割り当てたスタイルが優先', () => {
    const mine = { style: { ...defaultTextStyle(), color: '#ffe600', fontSize: 64 }, styleId: 'my' }
    const plan = planRoughCut(project, info, scenes, judgements, activity, {
      targetSec: 0,
      styles: [],
      speechLook: mine,
      level
    })
    expect(plan.telops.length).toBeGreaterThan(0)
    for (const t of plan.telops) {
      expect(t.styleId).toBe('my')
      expect(t.style.color).toBe('#ffe600')
      expect(t.style.fontSize).toBe(64)
    }
    const assigned = {
      id: 'a',
      name: '出演者A用',
      style: { ...defaultTextStyle(), color: '#00ff00' },
      speakers: ['出演者A']
    }
    const plan2 = planRoughCut(project, info, scenes, judgements, activity, {
      targetSec: 0,
      styles: [assigned],
      speechLook: mine,
      level
    })
    for (const t of plan2.telops) expect(t.styleId).toBe('a')
  })
})

describe('planRoughCut — 短い発言のテロップ', () => {
  const n = 30 * TURN_RATE
  const activity = new Uint8Array(n)
  activity.fill(1, 100, 400)
  const scenes: Scene[] = [{ id: 's1', start: 0, end: 30, lines: [], speech: 6 }]
  const judgements: SceneJudgement[] = [{ sceneId: 's1', score: 80, kind: 'normal', reason: '' }]
  const plan = (transcript: unknown[]): ReturnType<typeof planRoughCut> =>
    planRoughCut(
      { aspectRatio: '16:9', transcript } as unknown as Project,
      info,
      scenes,
      judgements,
      activity,
      { targetSec: 0, styles: [] }
    )

  it('最低表示時間で延ばした「はい」が次の発言に重なっても、次の発言を1段上へ積まない', () => {
    const p = plan([utt('u1', 1, 1.3, 'はい'), utt('u2', 1.7, 4, 'じゃあ次に行きましょう')])
    const [a, b] = [...p.telops].sort((x, y) => x.startTime - y.startTime)
    expect(a.endTime).toBeLessThanOrEqual(b.startTime + 1e-6)
    expect(b.style.customPosition).toBeUndefined()
  })

  it('声が本当に重なった所は、これまでどおり積んで両方見せる', () => {
    const p = plan([
      utt('u1', 1, 3, 'それはちょっと違うと思う'),
      {
        ...(utt('u2', 2, 4, 'いやいやそんなことない') as object),
        speaker: '出演者B',
        overlap: true
      }
    ])
    const [a, b] = [...p.telops].sort((x, y) => x.startTime - y.startTime)
    expect(a.endTime).toBeGreaterThan(b.startTime)
    expect(b.style.customPosition).toBeDefined()
  })
})

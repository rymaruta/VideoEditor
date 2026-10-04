import { describe, expect, it } from 'vitest'
import { effectOverlays } from '../../src/renderer/src/lib/roughCutPlan'
import type { EffectProposal } from '@shared/telop/effects'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Project } from '@shared/types'

// 素材の時刻 = 共通の時刻 = 仮編集の時刻 になる、いちばん単純な組み合わせ
const info: MulticamInfo = {
  anchorSourceId: 's1',
  sources: [],
  files: [{ assetId: 'a1', sourceId: 's1', start: 0, rate: 1, duration: 600 }]
}
const spans = [{ timeline: 0, start: 0, end: 600 }]

const line = (id: string, start: number, end: number): unknown => ({
  id,
  assetId: 'a1',
  sourceStart: start,
  sourceEnd: end,
  text: id,
  words: [],
  overlap: false
})

const name = (id: string, afterLineId: string, text: string): EffectProposal => ({
  id,
  afterLineId,
  kind: 'name',
  text,
  confidence: 1,
  reason: ''
})

describe('effectOverlays — 人物紹介どうしを重ねない', () => {
  it('2人目の名前が 0.5 秒未満で続いても、前の名前と時間が重ならない', () => {
    const project = {
      transcript: [line('u1', 10, 12), line('u2', 10.2, 13)]
    } as unknown as Project
    const proposals = [name('p1', 'u1', '山田'), name('p2', 'u2', '佐藤')]
    const out = effectOverlays(proposals, new Set(['p1', 'p2']), project, info, spans, [])
    expect(out).toHaveLength(2)
    const [first, second] = out
    // 前の名前は最低 0.5 秒は見せる
    expect(first.endTime - first.startTime).toBeGreaterThanOrEqual(0.5 - 1e-9)
    // 重ならない
    expect(second.startTime).toBeGreaterThanOrEqual(first.endTime - 1e-9)
    // 遅らせても長さは変えない
    const plain = effectOverlays([proposals[1]], new Set(['p2']), project, info, spans, [])[0]
    expect(second.endTime - second.startTime).toBeCloseTo(plain.endTime - plain.startTime, 9)
  })

  it('十分に離れていれば、次の名前は発言の頭に出て、前の名前はそこで下がる(対照)', () => {
    const project = {
      transcript: [line('u1', 10, 12), line('u2', 11, 13)]
    } as unknown as Project
    const out = effectOverlays(
      [name('p1', 'u1', '山田'), name('p2', 'u2', '佐藤')],
      new Set(['p1', 'p2']),
      project,
      info,
      spans,
      []
    )
    expect(out[1].startTime).toBeCloseTo(11.05, 9)
    expect(out[0].endTime).toBeCloseTo(11.05, 9)
  })
})

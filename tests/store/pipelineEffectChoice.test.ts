import { beforeEach, describe, expect, it, vi } from 'vitest'

// 設定・プリセットのストアは読み込み時に localStorage を読む
vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})
import { useProjectStore } from '@renderer/store/projectStore'
import { usePipelineStore } from '@renderer/store/pipelineStore'
import type { EffectProposal } from '@shared/telop/effects'

const P = useProjectStore
const info = {
  anchorSourceId: 'A',
  sources: [{ id: 'A', name: 'カメラA', kind: 'camera' as const }],
  files: [{ assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 }]
}
const proposal = (id: string, at: number): EffectProposal => ({
  id,
  afterLineId: '',
  at,
  kind: 'laugh',
  text: '(一同爆笑)',
  confidence: 1,
  reason: ''
})
const placed = (): string[] =>
  P.getState()
    .project.textOverlays.map((o) => o.effectId ?? '')
    .filter(Boolean)
    .sort()

describe('演出テロップの提案を選ぶ', () => {
  beforeEach(() => {
    P.getState().newProject()
    P.setState({ project: { ...P.getState().project, multicam: info, clips: [] } })
    P.getState().applyRoughCut(
      {
        main: [{ assetId: 'camA', inPoint: 0, outPoint: 60, speed: 1 }],
        audio: [],
        duration: 60,
        spans: []
      },
      []
    )
    usePipelineStore.setState({
      effects: [proposal('x', 10), proposal('y', 40)],
      effectChosen: []
    })
  })

  it('選んだのを取り消してから別の提案を選んでも、取り消した提案は戻ってこない', () => {
    usePipelineStore.getState().setEffectChosen('x', true)
    expect(placed()).toEqual(['x'])
    P.getState().undo()
    expect(placed()).toEqual([])
    usePipelineStore.getState().setEffectChosen('y', true)
    expect(placed()).toEqual(['y'])
  })

  it('手で消した提案を選び直すと置き直し、取り消し1回で選ぶ前に戻る', () => {
    usePipelineStore.getState().setEffectChosen('x', true)
    const o = P.getState().project.textOverlays.find((t) => t.effectId === 'x')!
    P.getState().removeTextOverlay(o.id)
    expect(P.getState().project.dismissedTelops).toContain('e:x')
    usePipelineStore.getState().setEffectChosen('x', false)
    usePipelineStore.getState().setEffectChosen('x', true)
    expect(placed()).toEqual(['x'])
    P.getState().undo()
    expect(placed()).toEqual([])
    expect(P.getState().project.dismissedTelops).toContain('e:x')
  })
})

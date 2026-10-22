import { describe, expect, it } from 'vitest'
import {
  CONTINUE_ON_ERROR,
  RESTART_CONFIRM,
  nextAction,
  type NextActionInput
} from '@renderer/lib/autoEditNext'

// pipelineStore の工程(一部)
const LABEL: Record<string, string> = {
  ingest: '取り込み・整理',
  sync: 'カメラ・マイクの同期',
  color: 'カメラの色合わせ',
  denoise: 'ピンマイクのノイズ除去',
  transcribe: '文字起こし',
  events: '笑い・歓声の検出',
  structure: '構成',
  cut: 'カット',
  angles: 'アングルの切り替え',
  placement: '発言テロップの配置',
  effects: '演出テロップの提案',
  sound: 'SE・BGM・CG'
}
const steps = (
  states: Record<string, NextActionInput['steps'][number]['state']>,
  notes: Record<string, string> = {}
): NextActionInput['steps'] =>
  Object.keys(LABEL).map((id) => ({
    id,
    label: LABEL[id],
    state: states[id] ?? 'done',
    percent: 100,
    ...(notes[id] ? { note: notes[id] } : {})
  }))

const base: NextActionInput = {
  hasScan: true,
  cameras: 2,
  mics: 1,
  running: false,
  steps: steps({}),
  scenes: 20,
  roughCut: { kept: 12, duration: 600 },
  openIssues: 0,
  manualKeep: 0
}

describe('nextAction: 続けて進む失敗と止まる失敗を分ける(監査 中3)', () => {
  it('続けて進む失敗の工程は、pipelineStore で失敗を記録して先へ進む所', () => {
    expect([...CONTINUE_ON_ERROR].sort()).toEqual(
      ['color', 'denoise', 'events', 'placement', 'effects', 'sound'].sort()
    )
  })
  it.each(['color', 'denoise', 'events', 'placement', 'effects', 'sound'])(
    '%s だけの失敗で仮編集があれば「できました」に、できなかったことを添える',
    (id) => {
      const a = nextAction({ ...base, steps: steps({ [id]: 'error' }) })
      expect(a.kind).toBe('done')
      expect(a.primary.id).toBe('finish')
      expect(a.detail).toContain(`${LABEL[id]}はできませんでした`)
    }
  )
  it('続けて進む失敗だけで、仮編集がまだなら「仮編集を作る」', () => {
    const a = nextAction({ ...base, roughCut: null, steps: steps({ effects: 'error' }) })
    expect(a.kind).toBe('rebuild')
    expect(a.detail).toContain('演出テロップの提案はできませんでした')
  })
  it('作り直しの失敗(カット・アングル)は、全部やり直さず「仮編集を作り直す」を主に', () => {
    const a = nextAction({
      ...base,
      steps: steps({ cut: 'error' }, { cut: '残す場面がありません' })
    })
    expect(a.kind).toBe('error')
    expect(a.primary.id).toBe('rebuild')
    expect(a.detail).toContain('残す場面がありません')
    expect(a.secondary.map((b) => b.id)).toEqual(['finish'])
  })
  it('止まる失敗(同期)で収録フォルダがあれば「もう一度始める」。手で決めたものが無ければ確かめない', () => {
    const a = nextAction({ ...base, roughCut: null, scenes: 0, steps: steps({ sync: 'error' }) })
    expect(a.primary.id).toBe('retry')
    expect(a.primary.confirm).toBeUndefined()
  })
  it('手で決めた残す/落とすがあるときに全部やり直すなら、確かめる', () => {
    const a = nextAction({ ...base, manualKeep: 3, steps: steps({ transcribe: 'error' }) })
    expect(a.primary.id).toBe('retry')
    expect(a.primary.confirm).toBe(RESTART_CONFIRM)
    const b = nextAction({
      ...base,
      manualKeep: 3,
      roughCut: null,
      scenes: 0,
      steps: steps({ ingest: 'done', sync: 'done', transcribe: 'done' })
    })
    expect(b.kind).toBe('ready')
    expect(b.primary.confirm).toBe(RESTART_CONFIRM)
  })
  it('開き直した企画(収録フォルダなし)では、収録フォルダを選ぶを主にしない', () => {
    const a = nextAction({ ...base, hasScan: false, steps: steps({ sync: 'error' }) })
    expect(a.primary.id).toBe('finish')
    expect(a.secondary.map((b) => b.id)).toEqual(['newEpisode'])
    const b = nextAction({
      ...base,
      hasScan: false,
      roughCut: null,
      steps: steps({ structure: 'error' })
    })
    expect(b.primary.id).toBe('rebuild')
  })
  it('企画に何も無く止まったときだけ、収録フォルダを選ぶ', () => {
    const a = nextAction({
      ...base,
      hasScan: false,
      roughCut: null,
      scenes: 0,
      steps: steps({ sync: 'error' })
    })
    expect(a.primary.id).toBe('newEpisode')
  })
})

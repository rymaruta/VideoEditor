import { describe, expect, it } from 'vitest'
import { nextAction, type NextActionInput } from '@renderer/lib/autoEditNext'

const STEP_IDS = ['ingest', 'sync', 'transcribe', 'structure', 'cut']
const steps = (
  states: Partial<Record<string, NextActionInput['steps'][number]['state']>> = {},
  notes: Record<string, string> = {}
): NextActionInput['steps'] =>
  STEP_IDS.map((id) => ({
    id,
    label: {
      ingest: '取り込み',
      sync: '同期',
      transcribe: '文字起こし',
      structure: '構成',
      cut: 'カット'
    }[id]!,
    state: states[id] ?? 'wait',
    percent: states[id] === 'run' ? 40 : 0,
    ...(notes[id] ? { note: notes[id] } : {})
  }))

const base: NextActionInput = {
  hasScan: false,
  cameras: 0,
  mics: 0,
  running: false,
  steps: steps(),
  scenes: 0,
  roughCut: null,
  openIssues: 0
}

describe('nextAction(自動編集の画面の「次にやること」)', () => {
  it('素材が無いとき: 収録フォルダを選ぶ', () => {
    const a = nextAction(base)
    expect(a.kind).toBe('no-footage')
    expect(a.primary).toEqual({ id: 'newEpisode', label: '収録フォルダを選ぶ…' })
    expect(a.secondary).toEqual([])
  })
  it('始める前: 読んだ機材の数を書き、自動編集を始める', () => {
    const a = nextAction({ ...base, hasScan: true, cameras: 2, mics: 1 })
    expect(a.kind).toBe('ready')
    expect(a.detail).toContain('カメラ 2 台・マイク 1 本')
    expect(a.primary.id).toBe('start')
    expect(a.primary.label).toBe('自動編集を始める')
  })
  it('マイクだけ・カメラだけのときは、無い機材を書かない', () => {
    expect(nextAction({ ...base, hasScan: true, mics: 2 }).detail).not.toContain('カメラ')
    expect(nextAction({ ...base, hasScan: true, cameras: 1 }).detail).not.toContain('マイク')
  })
  it('進行中: 今の工程と済んだ数。主ボタンは編集画面に戻って待つ、中止は脇', () => {
    const a = nextAction({
      ...base,
      hasScan: true,
      cameras: 1,
      running: true,
      steps: steps({ ingest: 'done', sync: 'skipped', transcribe: 'run' })
    })
    expect(a.kind).toBe('running')
    expect(a.title).toBe('文字起こしを進めています')
    expect(a.detail).toContain('2 / 5 工程')
    expect(a.primary.id).toBe('background')
    expect(a.secondary.map((b) => b.id)).toEqual(['cancel'])
  })
  it('止まったとき: どこで止まったかと理由。収録フォルダがあればもう一度始める', () => {
    const a = nextAction({
      ...base,
      hasScan: true,
      cameras: 1,
      steps: steps({ ingest: 'done', sync: 'error' }, { sync: '音が一致しませんでした' })
    })
    expect(a.kind).toBe('error')
    expect(a.title).toBe('「同期」で止まりました')
    expect(a.detail).toContain('音が一致しませんでした')
    expect(a.primary.id).toBe('retry')
  })
  it('止まったが収録フォルダが無い(開き直した企画): フォルダを選ぶ', () => {
    const a = nextAction({ ...base, steps: steps({ sync: 'error' }) })
    expect(a.primary.id).toBe('newEpisode')
  })
  it('終わった後: 編集画面で仕上げる・書き出す。要確認があれば見るボタンも', () => {
    const a = nextAction({
      ...base,
      steps: steps({
        ingest: 'done',
        sync: 'done',
        transcribe: 'done',
        structure: 'done',
        cut: 'done'
      }),
      scenes: 34,
      roughCut: { kept: 21, duration: 242.04 },
      openIssues: 3
    })
    expect(a.kind).toBe('done')
    expect(a.detail).toContain('21 場面を残し、仕上がりは 4:02')
    expect(a.primary).toEqual({ id: 'finish', label: '編集画面で仕上げる' })
    expect(a.secondary.map((b) => b.id)).toEqual(['review', 'export'])
    expect(a.secondary[0].label).toBe('要確認 3 件を見る')
  })
  it('終わった後で要確認が無ければ、書き出すだけを脇に', () => {
    const a = nextAction({ ...base, roughCut: { kept: 5, duration: 60 }, scenes: 8 })
    expect(a.secondary.map((b) => b.id)).toEqual(['export'])
    expect(a.detail).not.toContain('自信の低い所')
  })
  it('構成だけある(開き直した企画で仮編集が無い): 仮編集を作る', () => {
    const a = nextAction({ ...base, scenes: 12 })
    expect(a.kind).toBe('rebuild')
    expect(a.primary.id).toBe('rebuild')
    expect(a.detail).toContain('12 場面')
  })
  it('進行中は、仮編集があっても進行中を先に出す', () => {
    const a = nextAction({
      ...base,
      running: true,
      roughCut: { kept: 1, duration: 10 },
      steps: steps({ cut: 'run' })
    })
    expect(a.kind).toBe('running')
  })
})

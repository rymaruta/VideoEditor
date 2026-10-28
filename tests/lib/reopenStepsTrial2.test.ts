import { describe, expect, it, vi } from 'vitest'

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
import { STEPS, usePipelineStore } from '@renderer/store/pipelineStore'
import { useProjectStore } from '@renderer/store/projectStore'
import { overallProgress } from '@renderer/lib/autoEditView'
import type { Project } from '@shared/types'
import { flush, runEpisode } from '../helpers/episodeHarness'

/**
 * 試し編集 第2回の不具合 11: 保存して開き直すと「93% · 13 / 14 工程」になった。分からないのは SE・BGM・CG の
 * 工程。番組素材フォルダが未設定で省いた回は自動のトラックが残らず、開き直すと「待機」になっていた
 */
describe('開き直しても、済んだ・省いた工程は「待機」にしない', () => {
  it('SE・BGM・CG を省いた回を開き直すと、省いたまま(14 / 14 工程)', async () => {
    await runEpisode()
    const ran = usePipelineStore.getState().steps
    expect(ran.sound.state).toBe('skipped')
    const saved = JSON.parse(JSON.stringify(useProjectStore.getState().project)) as Project
    useProjectStore.getState().newProject('別の回')
    await flush()
    useProjectStore.getState().loadProject(saved, '/r/第1回.veproj')
    await flush()
    const steps = usePipelineStore.getState().steps
    const waiting = STEPS.filter((s) => steps[s.id].state === 'wait').map((s) => s.label)
    expect(waiting).toEqual([])
    expect(steps.sound.state).toBe('skipped')
    expect(steps.sound.note).toBe('番組素材フォルダが未設定です')
    const after = overallProgress(
      STEPS.map((s) => ({ id: s.id, ...steps[s.id] })),
      false
    )
    expect(after.finished).toBe(after.total)
    expect(after.percent).toBe(100)
  })
})

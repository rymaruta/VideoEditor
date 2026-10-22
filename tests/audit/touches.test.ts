/* eslint-disable @typescript-eslint/explicit-function-return-type -- 監査で書いた再現の試験をそのまま取り込んだもの */
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
import { usePipelineStore } from '@renderer/store/pipelineStore'
import { useProjectStore } from '@renderer/store/projectStore'
import { DEFAULT_RANGED_OPTIONS, mainLength } from '@renderer/lib/rangedAutoEdit'
import { clipTimes } from '@shared/roughCut/range'
import { spansOfClips } from '@shared/roughCut/overrides'
import { sceneOfSpan } from '@renderer/lib/roughCutPlan'
import { episode2, inter, len, project, cov } from './h'

function sceneClips(id: string) {
  const p = project()
  const spans = spansOfClips(p.clips, p.multicam!)
  const scenes = usePipelineStore.getState().scenes
  return p.clips.filter((_, i) => sceneOfSpan(scenes, spans[i]) === id)
}
async function setup(retouch: boolean) {
  await episode2()
  usePipelineStore.getState().setTargetMinutes(6)
  await usePipelineStore.getState().rebuildRoughCut()
  const st = usePipelineStore.getState()
  const kept = st.roughCut!.keptIds
  // 頭と終わり以外の残した場面
  console.log(
    JSON.stringify(
      st.scenes.map((s) => [s.id, s.start, s.end, kept.includes(s.id), sceneClips(s.id).length])
    )
  )
  const sc = st.scenes.find(
    (s, k) =>
      k > 0 && k < st.scenes.length - 1 && kept.includes(s.id) && sceneClips(s.id).length > 0
  )!
  const ids = sceneClips(sc.id).map((c) => c.id)
  const p = project()
  const t = clipTimes(p.clips)
  const first = p.clips.findIndex((c) => c.id === ids[0])
  const at = t[first].start
  useProjectStore.getState().removeClips(ids)
  if (retouch) {
    usePipelineStore.getState().setKeep(sc.id, false)
    usePipelineStore.getState().setKeep(sc.id, true)
  }
  return { sc, at }
}
const present = (sc: { start: number; end: number }) => len(inter(cov(), [sc]))

describe('付け直し と 範囲の自動編集', () => {
  for (const keepInside of [false, true])
    it(`付け直した場面を範囲で戻す(keepInside=${keepInside}) → 取り消し → 全体の作り直しで戻る`, async () => {
      const { sc, at } = await setup(true)
      expect(usePipelineStore.getState().keepTouched).toContain(sc.id)
      const r = await usePipelineStore
        .getState()
        .prepareRangedEdit(
          { start: Math.max(0, at - 3), end: Math.min(mainLength(project()), at + 3) },
          { ...DEFAULT_RANGED_OPTIONS, keepInside },
          { exact: true }
        )
      if (!r.ok) throw new Error(r.reason)
      usePipelineStore.getState().applyRangedEdit(r.preview)
      console.log(
        'in range revived',
        present(sc).toFixed(2),
        'touched',
        usePipelineStore.getState().keepTouched
      )
      useProjectStore.getState().undo()
      console.log(
        'after undo touched',
        usePipelineStore.getState().keepTouched,
        'present',
        present(sc).toFixed(2)
      )
      expect(usePipelineStore.getState().keepTouched).toContain(sc.id)
      await usePipelineStore.getState().rebuildRoughCut()
      expect(present(sc)).toBeGreaterThan(1)
    })
  it('付け直していない丸ごと消した場面: 範囲(手直しを残す)でも全体の作り直しでも戻らない', async () => {
    const { sc, at } = await setup(false)
    const r = await usePipelineStore
      .getState()
      .prepareRangedEdit(
        { start: Math.max(0, at - 3), end: Math.min(mainLength(project()), at + 3) },
        { ...DEFAULT_RANGED_OPTIONS, keepInside: true },
        { exact: true }
      )
    if (!r.ok) throw new Error(r.reason)
    usePipelineStore.getState().applyRangedEdit(r.preview)
    console.log('no-retouch range present', present(sc).toFixed(2))
    expect(present(sc)).toBeLessThan(0.3)
    await usePipelineStore.getState().rebuildRoughCut()
    console.log('no-retouch rebuild present', present(sc).toFixed(2))
    expect(present(sc)).toBeLessThan(0.3)
  })
  it('付け直した場面を範囲(範囲の外)→ 全体の作り直しで戻る、やり直し後は戻さない', async () => {
    const { sc } = await setup(true)
    const total = mainLength(project())
    const r = await usePipelineStore
      .getState()
      .prepareRangedEdit({ start: 0, end: 4 }, { ...DEFAULT_RANGED_OPTIONS }, { exact: true })
    if (!r.ok) throw new Error(r.reason)
    usePipelineStore.getState().applyRangedEdit(r.preview)
    void total
    console.log('outside touched', usePipelineStore.getState().keepTouched, r.preview.sceneIds)
    expect(usePipelineStore.getState().keepTouched).toContain(sc.id)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(present(sc)).toBeGreaterThan(1)
  })
})

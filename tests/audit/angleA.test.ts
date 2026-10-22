/* eslint-disable @typescript-eslint/explicit-function-return-type -- 監査で書いた再現の試験をそのまま取り込んだもの */
import { expect, it, vi } from 'vitest'
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
import { angleAlternatives } from '@shared/roughCut/overrides'
import { episode2, project } from './h'
for (const ctrl of [false, true])
  it(`A(angle): カメラを替える → 範囲(アングルをやり直さない) → 全体の作り直し ctrl=${ctrl}`, async () => {
    await episode2()
    const total = mainLength(project())
    const range = {
      start: Math.round(total * 0.3 * 30) / 30,
      end: Math.round(total * 0.7 * 30) / 30
    }
    const mid = (range.start + range.end) / 2
    const camAt = () => {
      const p = project()
      const t = clipTimes(p.clips)
      const i = p.clips.findIndex((_, k) => t[k].start <= mid && t[k].end > mid)
      return {
        c: p.clips[i],
        cam: p.multicam!.files.find((f) => f.assetId === p.clips[i].assetId)!.sourceId
      }
    }
    const { c, cam } = camAt()
    const other = angleAlternatives(c, project().multicam!).find(
      (a) => a.sourceId !== cam && a.clips?.length
    )!.sourceId
    useProjectStore.getState().switchClipAngle(c.id, other)
    if (!ctrl) {
      const r = await usePipelineStore
        .getState()
        .prepareRangedEdit(
          range,
          { ...DEFAULT_RANGED_OPTIONS, steps: { ...DEFAULT_RANGED_OPTIONS.steps, angles: false } },
          { exact: true }
        )
      if (!r.ok) throw new Error(r.reason)
      usePipelineStore.getState().applyRangedEdit(r.preview)
      console.log('after range cam', camAt().cam, 'hand', other)
    }
    await usePipelineStore.getState().rebuildRoughCut()
    console.log('ctrl', ctrl, 'after rebuild cam', camAt().cam, 'hand', other)
    expect(camAt().cam).toBe(other)
  })

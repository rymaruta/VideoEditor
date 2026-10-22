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
import {
  DEFAULT_RANGED_OPTIONS,
  mainLength,
  type RangedEditOptions
} from '@renderer/lib/rangedAutoEdit'
import { clipTimes, commonWindowOf } from '@shared/roughCut/range'
import { cov, episode2, inter, len, memory, project } from './h'

async function ranged(
  range: { start: number; end: number },
  o: Partial<RangedEditOptions> & { steps?: Partial<RangedEditOptions['steps']> } = {}
) {
  const r = await usePipelineStore.getState().prepareRangedEdit(
    range,
    {
      ...DEFAULT_RANGED_OPTIONS,
      ...o,
      steps: { ...DEFAULT_RANGED_OPTIONS.steps, ...(o.steps ?? {}) }
    },
    { exact: true }
  )
  if (!r.ok) throw new Error(r.reason)
  expect(usePipelineStore.getState().applyRangedEdit(r.preview).ok).toBe(true)
  return r.preview
}

/** 範囲の真ん中のクリップのお尻を2秒詰め、消した共通の時刻を返す */
function removeInside(range: { start: number; end: number }) {
  const p = project()
  const t = clipTimes(p.clips)
  const mid = (range.start + range.end) / 2
  const i = p.clips.findIndex((_, k) => t[k].start <= mid && t[k].end > mid)
  const c = p.clips[i]
  const before = cov()
  const cut = Math.min(2, (t[i].end - t[i].start) / 2)
  useProjectStore.getState().updateClipTrim(c.id, c.inPoint, c.outPoint - cut)
  const after = cov()
  return before.flatMap((b) => [b]).length ? minusR(before, after) : []
}
import { subtractRanges as minusR } from '@shared/roughCut/overrides'

describe('audit targeted', () => {
  for (const variant of [
    { name: 'cut=false keepInside=false', o: { steps: { cut: false } } },
    {
      name: 'cut=false angles=false keepInside=false',
      o: { steps: { cut: false, angles: false } }
    },
    { name: 'cut=true keepInside=true', o: { keepInside: true } },
    { name: 'cut=false keepInside=true', o: { keepInside: true, steps: { cut: false } } }
  ] as const) {
    it(`手で消した所: 範囲の自動編集(${variant.name}) → 全体の作り直し`, async () => {
      await episode2()
      const total = mainLength(project())
      const range = {
        start: Math.round(total * 0.3 * 30) / 30,
        end: Math.round(total * 0.6 * 30) / 30
      }
      const gone = removeInside(range)
      const goneLen = len(gone)
      expect(goneLen).toBeGreaterThan(0.5)
      const memBefore = memory()
      expect(len(inter(memBefore.removed, gone))).toBeGreaterThan(goneLen - 0.05)
      await ranged({ start: range.start, end: range.end - 0 }, variant.o as never)
      const stillGoneAfterRange = goneLen - len(inter(cov(), gone))
      const memAfterRange = len(inter(memory().removed, gone))
      await usePipelineStore.getState().rebuildRoughCut()
      const stillGoneAfterRebuild = goneLen - len(inter(cov(), gone))
      console.log(variant.name, {
        goneLen,
        stillGoneAfterRange,
        memAfterRange,
        stillGoneAfterRebuild
      })
      if (stillGoneAfterRange > goneLen - 0.05)
        expect(stillGoneAfterRebuild).toBeGreaterThan(goneLen - 0.05)
    })
  }

  it('ロックの中で手で消す → 作り直し → ロックを外す → 作り直し: 手直しが残る', async () => {
    await episode2()
    const total = mainLength(project())
    const cw = commonWindowOf(project().clips, project().multicam!, {
      start: total * 0.3,
      end: total * 0.6
    })
    if (!cw.ok) throw new Error()
    useProjectStore.getState().addAutoEditLock(cw.window)
    const range = { start: total * 0.3, end: total * 0.6 }
    const gone = removeInside(range)
    const goneLen = len(gone)
    const lockCov = inter(cov(), [cw.window])
    usePipelineStore.getState().setTargetMinutes(2.5)
    await usePipelineStore.getState().rebuildRoughCut()
    const lockCov2 = inter(cov(), [cw.window])
    expect(len(lockCov2)).toBeCloseTo(len(lockCov), 3)
    expect(goneLen - len(inter(cov(), gone))).toBeGreaterThan(goneLen - 0.05)
    const id = project().autoEditLocks![0].id
    useProjectStore.getState().removeAutoEditLock(id)
    await usePipelineStore.getState().rebuildRoughCut()
    console.log('unlock', { goneLen, still: goneLen - len(inter(cov(), gone)) })
    expect(goneLen - len(inter(cov(), gone))).toBeGreaterThan(goneLen - 0.05)
  })
})

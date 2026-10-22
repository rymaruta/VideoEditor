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
import { episode2, project, cov } from './h'
for (const steps of [{ cut: false }, { cut: false, angles: false }, { speech: false }])
  it(`遅くしたクリップを含む範囲を「長さを保つ」で ${JSON.stringify(steps)}`, async () => {
    await episode2()
    const total = mainLength(project())
    const range0 = {
      start: Math.round(total * 0.3 * 30) / 30,
      end: Math.round(total * 0.7 * 30) / 30
    }
    const p = project()
    const t = clipTimes(p.clips)
    const mid = (range0.start + range0.end) / 2
    const i = p.clips.findIndex((_, k) => t[k].start <= mid && t[k].end > mid)
    const slowLen = t[i].end - t[i].start
    useProjectStore.getState().updateClipSpeed(p.clips[i].id, 0.5)
    const range = { start: range0.start, end: range0.end + slowLen }
    const covBefore = cov()
    const r = await usePipelineStore.getState().prepareRangedEdit(
      range,
      {
        ...DEFAULT_RANGED_OPTIONS,
        keepLength: true,
        steps: { ...DEFAULT_RANGED_OPTIONS.steps, ...steps }
      },
      { exact: true }
    )
    // 埋めきれないときは当てずにリップルを勧める
    if (!r.ok) {
      expect(r.needsRipple).toBe(true)
      return
    }
    usePipelineStore.getState().applyRangedEdit(r.preview)
    const q = project()
    const dur = new Map(q.assets.map((a) => [a.id, a.duration]))
    const bad = q.clips.filter((c) => c.outPoint > (dur.get(c.assetId) ?? Infinity) + 1e-6)
    const win = r.preview.window
    const outOfWin = cov().filter(
      (s) =>
        s.end > win.end + 0.05 &&
        !covBefore.some((b) => b.start <= s.start + 1e-3 && b.end >= s.end - 1e-3)
    )
    console.log(
      JSON.stringify(steps),
      'window',
      win.start.toFixed(2),
      win.end.toFixed(2),
      'clips past source end',
      bad.map((c) => [c.inPoint.toFixed(2), c.outPoint.toFixed(2), dur.get(c.assetId)]),
      'new material beyond window',
      outOfWin.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`)
    )
    expect(bad).toEqual([])
    expect(outOfWin).toEqual([])
  })

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
import { commonWindowOf } from '@shared/roughCut/range'
import { episode2, project } from './h'
const overlaps = () => {
  const sp = project()
    .textOverlays.filter((x) => x.utteranceId)
    .sort((a, b) => a.startTime - b.startTime)
  const r: string[] = []
  for (let i = 0; i < sp.length; i++)
    for (let j = i + 1; j < sp.length && sp[j].startTime < sp[i].endTime - 0.05; j++)
      if (sp[j].utteranceId === sp[i].utteranceId)
        r.push(
          `${sp[i].text.replace(/\n/g, '')} [${sp[i].startTime.toFixed(2)}-${sp[i].endTime.toFixed(2)}] & [${sp[j].startTime.toFixed(2)}-${sp[j].endTime.toFixed(2)}]`
        )
  return r
}
for (const mode of ['range', 'lock'] as const)
  it(`発言テロップの途中に境(I/O)を置く: ${mode}`, async () => {
    await episode2(false)
    usePipelineStore.getState().setTargetMinutes(6)
    await usePipelineStore.getState().rebuildRoughCut()
    const total = mainLength(project())
    const t = project().textOverlays.filter(
      (o) =>
        o.utteranceId &&
        o.endTime - o.startTime > 3 &&
        o.startTime > total * 0.2 &&
        o.endTime < total * 0.6
    )[0]
    const a = Math.round(((t.startTime + t.endTime) / 2 + 0.4) * 30) / 30
    const b = Math.round((a + 25) * 30) / 30
    expect(overlaps()).toEqual([])
    if (mode === 'range') {
      const r = await usePipelineStore
        .getState()
        .prepareRangedEdit({ start: a, end: b }, DEFAULT_RANGED_OPTIONS, { exact: true })
      if (!r.ok) throw new Error(r.reason)
      usePipelineStore.getState().applyRangedEdit(r.preview)
    } else {
      const cw = commonWindowOf(project().clips, project().multicam!, { start: a, end: b })
      if (!cw.ok) throw new Error()
      useProjectStore.getState().addAutoEditLock(cw.window)
      usePipelineStore.getState().setTargetMinutes(2)
      await usePipelineStore.getState().rebuildRoughCut()
    }
    console.log(
      mode,
      'telop',
      t.text.replace(/\n/g, ''),
      t.startTime.toFixed(2),
      t.endTime.toFixed(2),
      'boundary',
      a,
      '\n',
      overlaps().join('\n')
    )
    expect(overlaps()).toEqual([])
  })

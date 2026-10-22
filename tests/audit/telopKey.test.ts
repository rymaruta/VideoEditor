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
import { autoTelopKey } from '@shared/telop/manual'
import { commonWindowOf } from '@shared/roughCut/range'
import { episode2, project } from './h'
for (const mode of ['range', 'lock'] as const)
  it(`境で切った同じ発言の2枚: ${mode}`, async () => {
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
      usePipelineStore.getState().setTargetMinutes(5.9)
      await usePipelineStore.getState().rebuildRoughCut()
    }
    const same = project().textOverlays.filter((o) => o.utteranceId === t.utteranceId)
    console.log(
      mode,
      same
        .map(
          (o) =>
            `[${o.startTime.toFixed(2)}-${o.endTime.toFixed(2)}] ${o.text.replace(/\n/g, '')} key=${autoTelopKey(o)} pos=${JSON.stringify(o.style?.position ?? (o as never as { position: unknown }).position)} y=${(o.style as never as { y?: number })?.y}`
        )
        .join('\n')
    )
    if (same.length < 2) return
    // 人が重なって見える片方(前の切れ端)を消す → 全体の作り直し
    useProjectStore.getState().removeTextOverlay(same[0].id)
    console.log('dismissed', project().dismissedTelops)
    await usePipelineStore.getState().rebuildRoughCut()
    const after = project().textOverlays.filter((o) => o.utteranceId === t.utteranceId)
    console.log(
      mode,
      'after rebuild',
      after.length,
      after.map((o) => `[${o.startTime.toFixed(2)}-${o.endTime.toFixed(2)}]`).join(' ')
    )
    expect(after.length).toBeGreaterThan(0)
  })

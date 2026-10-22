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
import { clipTimes, commonWindowOf } from '@shared/roughCut/range'
import { angleAlternatives, subtractRanges } from '@shared/roughCut/overrides'
import { cov, episode2, inter, len, memory, project } from './h'

function midClip(range: { start: number; end: number }) {
  const p = project()
  const t = clipTimes(p.clips)
  const mid = (range.start + range.end) / 2
  const i = p.clips.findIndex((_, k) => t[k].start <= mid && t[k].end > mid)
  return { i, c: p.clips[i], t: t[i] }
}

describe('audit targeted 2', () => {
  it('B: 範囲の中の手直しを残す+長さを保つ: 手で詰めた所が埋め戻されない', async () => {
    await episode2()
    const total = mainLength(project())
    const range = {
      start: Math.round(total * 0.3 * 30) / 30,
      end: Math.round(total * 0.7 * 30) / 30
    }
    const { c } = midClip(range)
    const b0 = cov()
    useProjectStore.getState().updateClipTrim(c.id, c.inPoint, c.outPoint - 2)
    const gone = subtractRanges(b0, cov())
    // 範囲は詰めた後の本編の時刻で(詰めた分だけ短い)
    const r = await usePipelineStore
      .getState()
      .prepareRangedEdit(
        { start: range.start, end: range.end - 2 },
        { ...DEFAULT_RANGED_OPTIONS, keepInside: true, keepLength: true },
        { exact: true }
      )
    if (!r.ok) throw new Error(r.reason)
    usePipelineStore.getState().applyRangedEdit(r.preview)
    const back = len(inter(cov(), gone))
    console.log(
      'B refilled',
      back.toFixed(2),
      'of',
      len(gone).toFixed(2),
      'memory still says removed',
      len(inter(memory().removed, gone)).toFixed(2)
    )
    expect(back).toBeLessThan(0.05)
  })

  it('C1: ロック中にカメラを替え→全体の作り直し→元のカメラに戻す→ロックを外して作り直し: 戻したカメラのまま', async () => {
    await episode2()
    const total = mainLength(project())
    const range = { start: total * 0.3, end: total * 0.7 }
    const cw = commonWindowOf(project().clips, project().multicam!, range)
    if (!cw.ok) throw new Error()
    useProjectStore.getState().addAutoEditLock(cw.window)
    const { c } = midClip(range)
    const info = project().multicam!
    const orig = info.files.find((f) => f.assetId === c.assetId)!.sourceId
    const other = angleAlternatives(c, info).find(
      (a) => a.sourceId !== orig && a.clips?.length
    )!.sourceId
    useProjectStore.getState().switchClipAngle(c.id, other)
    await usePipelineStore.getState().rebuildRoughCut()
    const { c: c2 } = midClip(range)
    expect(info.files.find((f) => f.assetId === c2.assetId)!.sourceId).toBe(other)
    useProjectStore.getState().switchClipAngle(c2.id, orig)
    const camNow = () => {
      const { c: x } = midClip(range)
      return info.files.find((f) => f.assetId === x.assetId)!.sourceId
    }
    expect(camNow()).toBe(orig)
    useProjectStore.getState().removeAutoEditLock(project().autoEditLocks![0].id)
    await usePipelineStore.getState().rebuildRoughCut()
    console.log('C1 camera after unlock rebuild', camNow(), 'human chose', orig)
    expect(camNow()).toBe(orig)
  })

  it('C2: ロック中に詰める→全体の作り直し→詰めたのを戻す→ロックを外して作り直し: 戻した所が残る', async () => {
    await episode2()
    const total = mainLength(project())
    const range = { start: total * 0.3, end: total * 0.7 }
    const cw = commonWindowOf(project().clips, project().multicam!, range)
    if (!cw.ok) throw new Error()
    useProjectStore.getState().addAutoEditLock(cw.window)
    const { c } = midClip(range)
    const b0 = cov()
    useProjectStore.getState().updateClipTrim(c.id, c.inPoint, c.outPoint - 2)
    const gone = subtractRanges(b0, cov())
    await usePipelineStore.getState().rebuildRoughCut()
    // 詰めたのを手で戻す(お尻を伸ばす)
    const p = project()
    const info = p.multicam!
    const k = p.clips.findIndex((x) => {
      const f = info.files.find((f) => f.assetId === x.assetId)!
      return Math.abs(f.start + x.outPoint / f.rate - gone[0].start) < 0.01
    })
    expect(k).toBeGreaterThanOrEqual(0)
    const x = p.clips[k]
    useProjectStore.getState().updateClipTrim(x.id, x.inPoint, x.outPoint + 2)
    expect(len(inter(cov(), gone))).toBeGreaterThan(1.95)
    useProjectStore.getState().removeAutoEditLock(project().autoEditLocks![0].id)
    await usePipelineStore.getState().rebuildRoughCut()
    console.log('C2 restored part after unlock rebuild', len(inter(cov(), gone)).toFixed(2))
    expect(len(inter(cov(), gone))).toBeGreaterThan(1.95)
  })
  it('CTRL-1 C1: ロック中にカメラを替え→全体の作り直し→元のカメラに戻す→ロックを外して作り直し: 戻したカメラのまま', async () => {
    await episode2()
    const total = mainLength(project())
    const range = { start: total * 0.3, end: total * 0.7 }
    const cw = commonWindowOf(project().clips, project().multicam!, range)
    if (!cw.ok) throw new Error()
    void cw
    const { c } = midClip(range)
    const info = project().multicam!
    const orig = info.files.find((f) => f.assetId === c.assetId)!.sourceId
    const other = angleAlternatives(c, info).find(
      (a) => a.sourceId !== orig && a.clips?.length
    )!.sourceId
    useProjectStore.getState().switchClipAngle(c.id, other)
    await usePipelineStore.getState().rebuildRoughCut()
    const { c: c2 } = midClip(range)
    expect(info.files.find((f) => f.assetId === c2.assetId)!.sourceId).toBe(other)
    useProjectStore.getState().switchClipAngle(c2.id, orig)
    const camNow = () => {
      const { c: x } = midClip(range)
      return info.files.find((f) => f.assetId === x.assetId)!.sourceId
    }
    expect(camNow()).toBe(orig)

    await usePipelineStore.getState().rebuildRoughCut()
    console.log('C1 camera after unlock rebuild', camNow(), 'human chose', orig)
    expect(camNow()).toBe(orig)
  })

  it('CTRL-2 C2: ロック中に詰める→全体の作り直し→詰めたのを戻す→ロックを外して作り直し: 戻した所が残る', async () => {
    await episode2()
    const total = mainLength(project())
    const range = { start: total * 0.3, end: total * 0.7 }
    const cw = commonWindowOf(project().clips, project().multicam!, range)
    if (!cw.ok) throw new Error()
    void cw
    const { c } = midClip(range)
    const b0 = cov()
    useProjectStore.getState().updateClipTrim(c.id, c.inPoint, c.outPoint - 2)
    const gone = subtractRanges(b0, cov())
    await usePipelineStore.getState().rebuildRoughCut()
    // 詰めたのを手で戻す(お尻を伸ばす)
    const p = project()
    const info = p.multicam!
    const k = p.clips.findIndex((x) => {
      const f = info.files.find((f) => f.assetId === x.assetId)!
      return Math.abs(f.start + x.outPoint / f.rate - gone[0].start) < 0.01
    })
    expect(k).toBeGreaterThanOrEqual(0)
    const x = p.clips[k]
    useProjectStore.getState().updateClipTrim(x.id, x.inPoint, x.outPoint + 2)
    expect(len(inter(cov(), gone))).toBeGreaterThan(1.95)

    await usePipelineStore.getState().rebuildRoughCut()
    console.log('C2 restored part after unlock rebuild', len(inter(cov(), gone)).toFixed(2))
    expect(len(inter(cov(), gone))).toBeGreaterThan(1.95)
  })
})

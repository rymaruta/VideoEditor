// 3c3a08f の再監査(zAudit4 の T7〜T9)と、variantFuzz の seed 333(ロックの中の発言テロップが 0.06 秒ずれる)。
// - T7: 続いて並ぶ1つのロックの直前・直後へ、ロックしていないクリップを並べ替えて置いても、作り直しでロックは
//   元の所(窓の所)に戻り、並べ替えたクリップに付いて動かない
// - T8: 3つのロックの複製を頭に入り組んで並べても、作り直し・取り消し・やり直し・もう一度の作り直しで並びが
//   変わらない
// - T9: 1つのロックの中で2本を入れ替えても、作り直しで並びが変わらない
// - ロックの中に掛かるごく短いテロップの切れ端(0.05 秒未満)も、外の同じ枚とつないで残す
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
  coverageOfClips,
  subtractRanges,
  unionRanges,
  type CameraSeg
} from '@shared/roughCut/overrides'
import { clipTimes, timelineWindowOf } from '@shared/roughCut/range'
import { toCommon } from '@shared/sync/multicam'
import type { Project } from '@shared/types'
import { episode2, len, lockNeighborMismatches, lockOrder, project } from './h'

const f = (s?: CameraSeg): string => (s ? `${s.cameraId}[${s.start.toFixed(0)}]` : 'x')
const sig = (): string =>
  project()
    .clips.map((c) => f(coverageOfClips([c], project().multicam!)[0]))
    .join(' ')
const total = (): string => {
  const t = clipTimes(project().clips)
  return t[t.length - 1].end.toFixed(2)
}
const ids = (): string[] => project().clips.map((c) => c.id)
const segOf = (id: string): CameraSeg =>
  coverageOfClips([project().clips.find((c) => c.id === id)!], project().multicam!)[0]
function dupTo(id: string, idx: number): string {
  useProjectStore.getState().duplicateClips([id])
  const copy = useProjectStore.getState().selectedClipId!
  useProjectStore.getState().moveClipToIndex(copy, idx)
  return copy
}
const lock = (id: string): void => {
  const s = segOf(id)
  useProjectStore.getState().addAutoEditLock({ start: s.start, end: s.end })
}

describe('3c3a08f の再監査: ロックは並べ替えたクリップに付いて動かない', () => {
  for (const where of ['直前', '直後'] as const)
    it(`T7 続いた1つのロックの${where}へ、ロックしていないクリップを並べ替えて置いても、ロックは元の所に戻る`, async () => {
      await episode2()
      const [c0, c1, c2, c3, c4] = ids()
      const order = [c0, c1, c2, c3, c4].map((id) => f(segOf(id))).join(' ')
      lock(c2)
      if (where === '直前') useProjectStore.getState().moveClipToIndex(c4, 2)
      else useProjectStore.getState().moveClipToIndex(c0, 2)
      expect(sig()).not.toBe(order)
      const t0 = total()
      const nb0 = lockNeighborMismatches()
      await usePipelineStore.getState().rebuildRoughCut()
      // 並べ替えたクリップは作り直しで共通の時刻の順に戻り、ロックは元の所(窓の所)のまま
      expect(sig()).toBe(order)
      expect(total()).toBe(t0)
      expect(lockNeighborMismatches().count).toBeLessThanOrEqual(nb0.count)
      expect(lockNeighborMismatches().inPlace.size).toBe(1)
    })

  it('T7c 比べ: 並べ替えずに作り直しても同じ', async () => {
    await episode2()
    const [, , c2] = ids()
    lock(c2)
    const b = sig()
    await usePipelineStore.getState().rebuildRoughCut()
    expect(sig()).toBe(b)
  })

  it('T8 3つのロックの複製を頭に入り組んで並べても、作り直し・取り消し・やり直し・もう一度の作り直しで並びが変わらない', async () => {
    await episode2()
    const [c0, , c2, , c4] = ids()
    dupTo(c4, 0)
    dupTo(c0, 1)
    dupTo(c2, 2)
    lock(c0)
    lock(c2)
    lock(c4)
    const b = sig()
    const o = lockOrder()
    await usePipelineStore.getState().rebuildRoughCut()
    const a = sig()
    expect(a).toBe(b)
    expect(lockOrder()).toBe(o)
    useProjectStore.getState().undo()
    expect(sig()).toBe(b)
    useProjectStore.getState().redo()
    expect(sig()).toBe(a)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(sig()).toBe(a)
  })

  it('T9 1つのロックの中で2本を入れ替えても、作り直しで並びが変わらない', async () => {
    await episode2()
    const [, c1, , c3] = ids()
    const s1 = segOf(c1)
    const s3 = segOf(c3)
    useProjectStore.getState().addAutoEditLock({ start: s1.start, end: s3.end })
    useProjectStore.getState().moveClipToIndex(c3, 1)
    const b = sig()
    await usePipelineStore.getState().rebuildRoughCut()
    expect(sig()).toBe(b)
  })
})

describe('ロックの中に掛かるごく短いテロップの切れ端(variantFuzz の seed 333)', () => {
  it('発言テロップがロックの終わりを 0.03 秒だけ越えても、ロックの中のテロップの時刻は作り直しで変わらない', async () => {
    await episode2()
    const p = project()
    const info = p.multicam!
    const t = clipTimes(p.clips)
    // 1本のクリップの中にある発言テロップ(頭から 0.1 秒以上あとに始まる)
    const i = p.clips.findIndex((_, k) =>
      p.textOverlays.some(
        (o) => o.utteranceId && o.startTime > t[k].start + 0.1 && o.endTime < t[k].end
      )
    )
    expect(i).toBeGreaterThanOrEqual(0)
    const c = p.clips[i]
    const o = p.textOverlays.find(
      (x) => x.utteranceId && x.startTime > t[i].start + 0.1 && x.endTime < t[i].end
    )!
    const file = info.files.find((x) => x.assetId === c.assetId)!
    const commonAt = (x: number): number =>
      toCommon(file, c.inPoint + (x - t[i].start) * (c.speed || 1))
    // ロックはクリップの頭から、テロップの頭の 0.03 秒あとまで(テロップの 0.03 秒だけがロックの中)
    const lockW = { start: commonAt(t[i].start), end: commonAt(o.startTime + 0.03) }
    useProjectStore.getState().addAutoEditLock(lockW)
    const speechIn = (q: Project): { start: number; end: number }[] => {
      const w = timelineWindowOf(q.clips, q.multicam!, lockW)!
      return unionRanges(
        q.textOverlays
          .filter((x) => x.utteranceId)
          .map((x) => ({
            start: Math.max(w.start, x.startTime) - w.start,
            end: Math.min(w.end, x.endTime) - w.start
          }))
          .filter((x) => x.end > x.start + 1e-6)
      )
    }
    const r0 = speechIn(project())
    expect(len(r0)).toBeGreaterThan(0.02)
    usePipelineStore.getState().setTargetMinutes(2.5)
    await usePipelineStore.getState().rebuildRoughCut()
    const r1 = speechIn(project())
    expect(len(subtractRanges(r0, r1)) + len(subtractRanges(r1, r0))).toBeLessThan(0.005)
    // ロックの境をまたいで、同じ発言の枚は1枚につながっている(0.03 秒だけ一瞬出る枚を作らない)
    const pieces = project().textOverlays.filter(
      (x) => x.utteranceId === o.utteranceId && x.endTime - x.startTime < 0.05
    )
    expect(pieces.length).toBe(0)
  })
})

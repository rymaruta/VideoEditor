// df19fea の監査(zBlocksAudit の T1〜T6)。続かないロックを作り直しても、ロックした塊は動かない:
// ほかのロックの塊を挟んでも(T1)、塊が3つでも(T2)、どの塊も順に並んでいなくても(T3)、
// 取り消し・やり直しでも(T5)、範囲の自動編集を隣り合わせても(T6)
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
import { DEFAULT_RANGED_OPTIONS } from '@renderer/lib/rangedAutoEdit'
import { lockRangesOf } from '@renderer/lib/timelineRange'
import { coverageOfClips, type CameraSeg, type Range } from '@shared/roughCut/overrides'
import { timelineBlocksOf } from '@shared/roughCut/range'
import { episode2, lockOrder, project } from './h'

const segOf = (id: string): CameraSeg =>
  coverageOfClips([project().clips.find((c) => c.id === id)!], project().multicam!)[0]
const fmt = (s?: CameraSeg): string =>
  s ? `${s.cameraId}[${s.start.toFixed(2)},${s.end.toFixed(2)}]` : '-'
/** 本編のクリップの並び(共通の時刻とカメラ) */
const sig = (): string[] =>
  project().clips.map((c) => fmt(coverageOfClips([c], project().multicam!)[0]))
const blockCount = (l: Range): number =>
  timelineBlocksOf(project().clips, project().multicam!, l).length
/** 本編のクリップの番号(真ん中あたり) */
function pick(ratio: number): string {
  const ids = project().clips.map((c) => c.id)
  return ids[Math.floor(ids.length * ratio)]
}
function dupTo(id: string, idx: number | 'end'): string {
  useProjectStore.getState().duplicateClips([id])
  const copy = useProjectStore.getState().selectedClipId!
  useProjectStore.getState().moveClipToIndex(copy, idx === 'end' ? project().clips.length - 1 : idx)
  return copy
}
const lockOf = (s: CameraSeg): Range => ({ start: s.start, end: s.end })

describe('df19fea の監査: ロックした塊は作り直しで動かない', () => {
  for (const scene of ['a: 2つの複製を頭に並べる', 'b: L1 が本編の頭のクリップ'] as const)
    it(`T1${scene}(互いの塊を挟む)`, async () => {
      await episode2()
      const a = scene.startsWith('a') ? pick(0.4) : project().clips[0].id
      const b = pick(0.7)
      const L1 = lockOf(segOf(a))
      const L2 = lockOf(segOf(b))
      dupTo(a, 0)
      dupTo(b, 1)
      useProjectStore.getState().addAutoEditLock(L1)
      useProjectStore.getState().addAutoEditLock(L2)
      const order0 = lockOrder()
      const head0 = sig().slice(0, 3)
      const n1 = blockCount(L1)
      const n2 = blockCount(L2)
      expect(n1).toBeGreaterThanOrEqual(2)
      await usePipelineStore.getState().rebuildRoughCut()
      // ロックした塊のタイムラインの順の並び(どのロックか・中身)は前のまま
      expect(lockOrder()).toBe(order0)
      expect(blockCount(L1)).toBe(n1)
      expect(blockCount(L2)).toBe(n2)
      // 頭に並べた複製は頭のまま(元の所へ寄せない)
      expect(sig().slice(0, 2)).toEqual(head0.slice(0, 2))
    })

  it('T2 塊が3つ(頭・元・終わり)でも、3つともその場に残る', async () => {
    await episode2()
    const a = pick(0.4)
    const L = lockOf(segOf(a))
    dupTo(a, 0)
    dupTo(a, 'end')
    useProjectStore.getState().addAutoEditLock(L)
    const order0 = lockOrder()
    const head0 = sig()[0]
    const last0 = sig().slice(-1)[0]
    expect(blockCount(L)).toBe(3)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(lockOrder()).toBe(order0)
    expect(blockCount(L)).toBe(3)
    expect(sig()[0]).toBe(head0)
    expect(sig().slice(-1)[0]).toBe(last0)
  })

  it('T3 どの塊も順に並んでいない(複製を頭・元を終わりへ)なら、窓の所へは何も入れず、どちらもその場に残る', async () => {
    await episode2()
    const a = pick(0.4)
    const L = lockOf(segOf(a))
    dupTo(a, 0)
    useProjectStore.getState().moveClipToIndex(a, project().clips.length - 1)
    useProjectStore.getState().addAutoEditLock(L)
    const order0 = lockOrder()
    const head0 = sig()[0]
    const last0 = sig().slice(-1)[0]
    expect(blockCount(L)).toBe(2)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(lockOrder()).toBe(order0)
    expect(blockCount(L)).toBe(2)
    expect(sig()[0]).toBe(head0)
    expect(sig().slice(-1)[0]).toBe(last0)
    // 窓の時刻を映すのは、その2本だけ(窓の所へ作り直した中身を入れていない)
    const shows = project().clips.filter((c) => {
      const s = coverageOfClips([c], project().multicam!)[0]
      return s && Math.min(s.end, L.end) - Math.max(s.start, L.start) > 0.02
    })
    expect(shows.length).toBe(2)
  })

  it('T5 取り消し・やり直しで、帯と中身が戻る', async () => {
    await episode2()
    const a = pick(0.4)
    const L = lockOf(segOf(a))
    dupTo(a, 0)
    useProjectStore.getState().addAutoEditLock(L)
    const bands = (): string => JSON.stringify(lockRangesOf(project()).map((r) => r.range))
    const band0 = bands()
    const s0 = sig().join()
    await usePipelineStore.getState().rebuildRoughCut()
    const band1 = bands()
    const s1 = sig().join()
    useProjectStore.getState().undo()
    expect(sig().join()).toBe(s0)
    expect(bands()).toBe(band0)
    useProjectStore.getState().redo()
    expect(sig().join()).toBe(s1)
    expect(bands()).toBe(band1)
  })

  it('T6 範囲の自動編集を、離れた塊(頭)のすぐ後ろ・元の塊のすぐ前に隣り合わせても、作り直しで並びが変わらない', async () => {
    await episode2()
    const a = pick(0.4)
    const L = lockOf(segOf(a))
    dupTo(a, 0)
    useProjectStore.getState().addAutoEditLock(L)
    const bs = timelineBlocksOf(project().clips, project().multicam!, L)
    expect(bs.length).toBe(2)
    for (const range of [
      { start: bs[0].end, end: bs[0].end + 8 },
      { start: bs[1].start - 8, end: bs[1].start }
    ]) {
      const r = await usePipelineStore
        .getState()
        .prepareRangedEdit(range, DEFAULT_RANGED_OPTIONS, { exact: true })
      if (!r.ok) continue
      expect(usePipelineStore.getState().applyRangedEdit(r.preview).ok).toBe(true)
    }
    const order0 = lockOrder()
    const head0 = sig()[0]
    await usePipelineStore.getState().rebuildRoughCut()
    expect(lockOrder()).toBe(order0)
    expect(blockCount(L)).toBe(2)
    expect(sig()[0]).toBe(head0)
  })
})

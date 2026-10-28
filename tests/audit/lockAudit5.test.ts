// 749eb0a の再監査(zAudit5 の T10〜T13)。隣り合うロック・ロックの間の手直し・速さを変えたロックの複製で、
// 作り直してもロックした所が動かず、ロックの外は作り直した本編の順(共通の時刻の順)に戻る
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
import { coverageOfClips, type CameraSeg } from '@shared/roughCut/overrides'
import { episode2, lockNeighborMismatches, lockOrder, project } from './h'

const f = (s?: CameraSeg): string =>
  s ? `${s.cameraId}[${s.start.toFixed(1)}-${s.end.toFixed(1)}]` : 'x'
/** 本編のクリップの並び(共通の時刻・カメラ・速さ) */
const sig = (): string =>
  project()
    .clips.map(
      (c) =>
        f(coverageOfClips([c], project().multicam!)[0]) +
        (c.speed && c.speed !== 1 ? `x${c.speed}` : '')
    )
    .join(' ')
const ids = (): string[] => project().clips.map((c) => c.id)
const segOf = (id: string): CameraSeg =>
  coverageOfClips([project().clips.find((c) => c.id === id)!], project().multicam!)[0]
const lock = (id: string): void => {
  const s = segOf(id)
  useProjectStore.getState().addAutoEditLock({ start: s.start, end: s.end })
}

describe('749eb0a の再監査: 隣り合うロック・ロックの間の手直し', () => {
  it('T10 隣り合う2つのロック(間の1秒は自動編集が削った所)を入れ替えて置いても、並びは変わらない', async () => {
    await episode2()
    const [, c1, c2] = ids()
    lock(c1)
    lock(c2)
    useProjectStore.getState().moveClipToIndex(c2, 1)
    const b = sig()
    const o = lockOrder()
    await usePipelineStore.getState().rebuildRoughCut()
    expect(sig()).toBe(b)
    expect(lockOrder()).toBe(o)
    expect(lockNeighborMismatches().count).toBe(0)
  })

  it('T11 2つのロックの間のクリップを手で詰めても、作り直しで並び・詰めた所が変わらない', async () => {
    await episode2()
    const [c0, c1, c2] = ids()
    lock(c0)
    lock(c2)
    const c = project().clips.find((x) => x.id === c1)!
    useProjectStore.getState().updateClipTrim(c1, c.inPoint + 2, c.outPoint - 2)
    const b = sig()
    await usePipelineStore.getState().rebuildRoughCut()
    expect(sig()).toBe(b)
  })

  it('T13 2つのロックの間のクリップを終わりへ動かすと、作り直しでロックの間へ戻り、ロックは動かない', async () => {
    await episode2()
    const [c0, c1, c2] = ids()
    const order = sig()
    lock(c0)
    lock(c2)
    useProjectStore.getState().moveClipToIndex(c1, project().clips.length - 1)
    expect(sig()).not.toBe(order)
    const o = lockOrder()
    const n0 = lockNeighborMismatches().count
    await usePipelineStore.getState().rebuildRoughCut()
    // ロックの外は作り直した本編の順(並べ替える前の並び)に戻る
    expect(sig()).toBe(order)
    expect(lockOrder()).toBe(o)
    expect(lockNeighborMismatches().count).toBeLessThanOrEqual(n0)
  })

  it('T12 速さを変えたロックのクリップと、その複製を頭へ置いても、作り直し・取り消し・やり直しで並びが変わらない', async () => {
    await episode2()
    const [, , c2] = ids()
    useProjectStore.getState().updateClipSpeed(c2, 1.5)
    lock(c2)
    useProjectStore.getState().duplicateClips([c2])
    const copy = useProjectStore.getState().selectedClipId!
    useProjectStore.getState().moveClipToIndex(copy, 0)
    const b = sig()
    await usePipelineStore.getState().rebuildRoughCut()
    const a = sig()
    expect(a).toBe(b)
    useProjectStore.getState().undo()
    expect(sig()).toBe(b)
    useProjectStore.getState().redo()
    expect(sig()).toBe(a)
  })
})

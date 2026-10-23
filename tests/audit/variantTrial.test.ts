/* eslint-disable @typescript-eslint/explicit-function-return-type -- 監査で書いた再現の試験を取り込んだもの */
// 範囲の作り直しの案の「試しに見る」の監査(e1507cb)。試しは履歴に積まず、閉じたら企画・履歴・自動編集の
// 記録が試す前と同じに戻る。決めたら履歴は1件。試している間は取り消し・保存で試しの案を扱わない
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
import { projectToSave, sameExceptAutoEdit, useProjectStore } from '@renderer/store/projectStore'
import { DEFAULT_RANGED_OPTIONS, mainLength } from '@renderer/lib/rangedAutoEdit'
import { episode2, project } from './h'

const snap = () => {
  const ps = usePipelineStore.getState()
  const st = useProjectStore.getState()
  return {
    json: JSON.stringify(project()),
    past: st.past.length,
    pastTop: st.past.at(-1),
    future: st.future.length,
    futureTop: st.future[0],
    dirty: st.isDirty,
    rangeRuns: JSON.stringify(ps.rangeRuns),
    builtKept: JSON.stringify(ps.builtKept),
    keepTouched: JSON.stringify(ps.keepTouched),
    roughCut: JSON.stringify(ps.roughCut),
    review: ps.rangeReview
  }
}

async function variants() {
  const total = mainLength(project())
  const r = await usePipelineStore
    .getState()
    .prepareRangedVariants({ start: total * 0.2, end: total * 0.8 }, DEFAULT_RANGED_OPTIONS)
  if (!r.ok) throw new Error(r.reason)
  expect(r.previews.length).toBeGreaterThanOrEqual(2)
  return r.previews
}

const pipe = () => usePipelineStore.getState()

describe('試しに見る(監査 中1・中3・中4)', () => {
  it('試して閉じる: 企画・履歴(やり直しも)・未保存の印・自動編集の記録が試す前と同じ', async () => {
    await episode2()
    // やり直しの履歴を作る(1つ消して取り消す)
    const c = project().clips[2]
    useProjectStore.getState().removeClip(c.id)
    useProjectStore.getState().undo()
    useProjectStore.getState().markSaved('/x.veproj', project())
    const before = snap()
    const list = await variants()
    for (const p of [...list, list[0]]) expect(pipe().tryRangedVariant(p, list).ok).toBe(true)
    expect(useProjectStore.getState().trial).not.toBeNull()
    pipe().cancelRangedTrial()
    expect(snap()).toEqual(before)
    expect(useProjectStore.getState().trial).toBeNull()
    // やり直しは試す前のもの(消したクリップをまた消す)
    useProjectStore.getState().redo()
    expect(project().clips.some((x) => x.id === c.id)).toBe(false)
  })

  it('試してから決める: 履歴は1件・やり直しは消える・取り消し1回で試す前に戻る', async () => {
    await episode2()
    const base = project()
    const before = snap()
    const list = await variants()
    pipe().tryRangedVariant(list[1], list)
    pipe().tryRangedVariant(list[0], list)
    expect(pipe().commitRangedVariant(list[0], list).ok).toBe(true)
    expect(useProjectStore.getState().trial).toBeNull()
    expect(useProjectStore.getState().past.length).toBe(before.past + 1)
    expect(useProjectStore.getState().past.at(-1)).toBe(base)
    expect(useProjectStore.getState().future.length).toBe(0)
    expect(sameExceptAutoEdit(project(), { ...list[0].after, autoEdit: project().autoEdit })).toBe(
      true
    )
    expect(pipe().rangeRuns.length).toBe(JSON.parse(before.rangeRuns).length + 1)
    expect(pipe().rangeReview?.current).toBe(list[0].variant.id)
    useProjectStore.getState().undo()
    expect(project().clips).toBe(base.clips)
    expect(JSON.stringify(pipe().rangeRuns)).toBe(before.rangeRuns)
    expect(JSON.stringify(pipe().roughCut)).toBe(before.roughCut)
  })

  it('試している案と違う案を「この案にする」と、その案に替えてから決める', async () => {
    await episode2()
    const before = snap()
    const list = await variants()
    pipe().tryRangedVariant(list[0], list)
    expect(pipe().commitRangedVariant(list[1], list).ok).toBe(true)
    expect(sameExceptAutoEdit(project(), { ...list[1].after, autoEdit: project().autoEdit })).toBe(
      true
    )
    expect(useProjectStore.getState().past.length).toBe(before.past + 1)
    expect(pipe().rangeRuns.length).toBe(JSON.parse(before.rangeRuns).length + 1)
  })

  it('試している間は取り消し・やり直し・帯からの替えをしない', async () => {
    await episode2()
    const list = await variants()
    pipe().tryRangedVariant(list[0], list)
    const trying = project()
    useProjectStore.getState().undo()
    useProjectStore.getState().redo()
    expect(project()).toBe(trying)
    expect(pipe().switchRangedVariant(list[1]).ok).toBe(false)
    expect(project()).toBe(trying)
    pipe().cancelRangedTrial()
  })

  it('試している間の保存・自動保存は試す前の企画を書き、未保存の印も試す前のもの', async () => {
    await episode2()
    useProjectStore.getState().markSaved('/x.veproj', project())
    const base = project()
    const list = await variants()
    pipe().tryRangedVariant(list[0], list)
    expect(projectToSave().project).toBe(base)
    expect(projectToSave().isDirty).toBe(false)
    // 試す前の企画を保存したことにしても、試しの案は保存済みにならない
    useProjectStore.getState().markSaved('/x.veproj', projectToSave().project)
    expect(useProjectStore.getState().currentFilePath).toBe('/x.veproj')
    pipe().cancelRangedTrial()
    expect(project()).toBe(base)
    expect(useProjectStore.getState().isDirty).toBe(false)
    // 決めたら未保存
    pipe().tryRangedVariant(list[0], list)
    pipe().commitRangedVariant(list[0], list)
    expect(projectToSave().project).toBe(project())
    expect(useProjectStore.getState().isDirty).toBe(true)
  })
})

describe('範囲の記録と仮編集のまとめ(監査 中2・中1)', () => {
  it('案を A → C → A と替えても範囲の記録は1件、取り消すと0件', async () => {
    await episode2()
    const list = await variants()
    const [a, c] = [list[0], list[list.length - 1]]
    const runs0 = pipe().rangeRuns.length
    pipe().applyRangedEdit(a, list)
    pipe().switchRangedVariant(c)
    pipe().switchRangedVariant(a)
    expect(pipe().rangeRuns.length).toBe(runs0 + 1)
    expect(project().autoEdit?.rangeRuns?.length ?? 0).toBe(runs0 + 1)
    useProjectStore.getState().undo()
    expect(pipe().rangeRuns.length).toBe(runs0)
    expect(project().autoEdit?.rangeRuns?.length ?? 0).toBe(runs0)
  })

  it('ふつうに当てて取り消すと、仮編集のまとめ(残した場面・長さ)も当てる前に戻り、やり直すと後に戻る', async () => {
    await episode2()
    const list = await variants()
    const rc0 = JSON.stringify(pipe().roughCut)
    const pick = list[list.length - 1]
    pipe().applyRangedEdit(pick, list)
    const rc1 = JSON.stringify(pipe().roughCut)
    expect(rc1).not.toBe(rc0)
    expect(pipe().roughCut?.duration).toBeCloseTo(mainLength(project()), 6)
    useProjectStore.getState().undo()
    expect(JSON.stringify(pipe().roughCut)).toBe(rc0)
    useProjectStore.getState().redo()
    expect(JSON.stringify(pipe().roughCut)).toBe(rc1)
  })

  it('帯を閉じたら案の一覧を持ち続けない', async () => {
    await episode2()
    const list = await variants()
    pipe().applyRangedEdit(list[0], list)
    expect(pipe().rangeReview?.variants.length).toBe(list.length)
    pipe().closeRangeReview()
    expect(pipe().rangeReview).toBeNull()
  })
})

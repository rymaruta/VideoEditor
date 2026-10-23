/* eslint-disable @typescript-eslint/explicit-function-return-type -- 再監査(398b05b)の再現の試験を取り込んだもの */
// 範囲の作り直しの案の再監査: 試している間に裏で届いた結果を閉じても残す(中A)、試している間はどの経路からも
// 本編を変えない(中B)、取り消し・やり直しで戻す仮編集のまとめが古い写しに戻らない(低)
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
import { projectToSave, useProjectStore } from '@renderer/store/projectStore'
import { DEFAULT_RANGED_OPTIONS, mainLength } from '@renderer/lib/rangedAutoEdit'
import { episode2, project } from './h'

const pipe = () => usePipelineStore.getState()
const ps = () => useProjectStore.getState()
async function vars() {
  const total = mainLength(project())
  const r = await pipe().prepareRangedVariants(
    { start: total * 0.2, end: total * 0.8 },
    DEFAULT_RANGED_OPTIONS
  )
  if (!r.ok) throw new Error(r.reason)
  return r.previews
}
const snap = () => ({
  json: JSON.stringify(project()),
  past: ps().past,
  future: ps().future,
  dirty: ps().isDirty,
  runs: JSON.stringify(pipe().rangeRuns),
  built: JSON.stringify(pipe().builtKept),
  kept: JSON.stringify(pipe().roughCut),
  touched: JSON.stringify(pipe().keepTouched)
})

/**
 * 本編を変えずにいてよい書き込み(裏の結果・自動編集の判断・保存の印)と、企画の切り替え・試しそのもの・
 * 取り消し(試している間は効かない)
 */
const ALLOWED = new Set([
  'setAutoEdit',
  'setAudioEvents',
  'setAssetProxyPath',
  'markSaved',
  'setMissingAssetPaths',
  'endTrial',
  'beginTrial',
  'undo',
  'redo',
  'newProject',
  'loadProject',
  'restoreAutosave'
])

describe('再監査(398b05b)', () => {
  it('試して閉じる(A,C,A,B)で企画・履歴・記録が全部一致し、やり直しも残る', async () => {
    await episode2()
    const c = project().clips[2]
    ps().removeClip(c.id)
    ps().undo()
    ps().markSaved('/x.veproj', project())
    const b = snap()
    const list = await vars()
    for (const id of ['A', 'C', 'A', 'B']) {
      const p = list.find((x) => x.variant.id === id)
      if (p) expect(pipe().tryRangedVariant(p, list).ok).toBe(true)
    }
    expect(JSON.stringify(projectToSave().project)).toBe(b.json)
    expect(projectToSave().isDirty).toBe(false)
    pipe().cancelRangedTrial()
    expect(snap()).toEqual(b)
  })

  it('中A: 試している間に届いたプロキシは、閉じても残る(自動編集の判断は試す前のまま)', async () => {
    await episode2()
    const b = snap()
    const list = await vars()
    const asset = project().assets[0]
    pipe().tryRangedVariant(list[0], list)
    ps().setAssetProxyPath(asset.id, '/proxy/a.mp4')
    pipe().cancelRangedTrial()
    expect(project().assets.find((x) => x.id === asset.id)?.proxyPath).toBe('/proxy/a.mp4')
    expect(JSON.stringify(project().autoEdit)).toBe(JSON.stringify(JSON.parse(b.json).autoEdit))
    expect(JSON.stringify({ ...project(), assets: [] })).toBe(
      JSON.stringify({ ...JSON.parse(b.json), assets: [] })
    )
    expect(ps().past).toBe(b.past)
  })

  it('中B: 試している間はメニューからのテロップ追加などを断り、知らせの数が増える', async () => {
    await episode2()
    const list = await vars()
    const past0 = ps().past.length
    pipe().tryRangedVariant(list[0], list)
    const trying = project()
    const past = ps().past
    const n0 = ps().trialRefused
    ps().addTextOverlay({
      text: 'menu telop',
      startTime: 1,
      endTime: 2,
      style: project().textOverlays[0]?.style
    } as never)
    expect(project()).toBe(trying)
    expect(ps().past).toBe(past)
    expect(ps().trialRefused).toBe(n0 + 1)
    // 決めると、範囲の編集だけが1件
    pipe().commitRangedVariant(list[0], list)
    expect(project().textOverlays.some((o) => o.text === 'menu telop')).toBe(false)
    expect(ps().past.length).toBe(past0 + 1)
  })

  it('中B: 試している間、本編を変える projectStore の操作はどれも本編を変えない(洗い出し)', async () => {
    await episode2()
    const list = await vars()
    pipe().tryRangedVariant(list[0], list)
    const p = project()
    const clip = p.clips[1]
    const ov = p.textOverlays[0]
    const asset = p.assets[0]
    const at = p.audioTracks[0]
    const guesses = (): unknown[][] => [
      [],
      [clip.id],
      [ov.id],
      [asset.id],
      [at.id],
      [clip.id, 1],
      [clip.id, clip.inPoint, clip.outPoint - 1],
      [ov.id, { text: 'x' }],
      [{ text: 'x', startTime: 1, endTime: 2, style: ov.style }],
      [[clip.id]],
      [at.id, 0.5],
      ['x'],
      [1],
      [true]
    ]
    const trying = project()
    const past = ps().past
    const changed: string[] = []
    const store = () => useProjectStore.getState() as unknown as Record<string, unknown>
    for (const key of Object.keys(store())) {
      if (typeof store()[key] !== 'function' || ALLOWED.has(key)) continue
      for (const args of guesses()) {
        const before = project()
        try {
          ;(store()[key] as (...a: unknown[]) => unknown)(...args)
        } catch {
          // 引数が合わない
        }
        if (project() !== before || ps().past !== past) {
          changed.push(key)
          useProjectStore.setState({ project: before, past })
          break
        }
      }
    }
    expect(changed).toEqual([])
    expect(project()).toBe(trying)
    expect(ps().trial).not.toBeNull()
    pipe().cancelRangedTrial()
  })

  it('低: 当てた後に構成で判断を変えてから取り消しても、仮編集のまとめは古い写しに戻らない', async () => {
    await episode2()
    const list = await vars()
    const rc0 = pipe().roughCut!
    pipe().applyRangedEdit(list[0], list)
    // 当てた後に、仮編集のまとめが別の理由で変わった(構成で判断を変えた など)
    usePipelineStore.setState({
      roughCut: { ...pipe().roughCut!, telops: 999, note: 'x' } as never
    })
    ps().undo()
    const rc = pipe().roughCut as unknown as Record<string, unknown>
    expect(rc.note).toBe('x')
    expect(rc.keptIds).toEqual(rc0.keptIds)
    expect(rc.duration).toBeCloseTo(mainLength(project()), 6)
  })

  it('範囲 → 手で削除 → 取り消し2回 → やり直し: 仮編集のまとめが行き来する', async () => {
    await episode2()
    const rc0 = JSON.stringify(pipe().roughCut)
    const list = await vars()
    pipe().applyRangedEdit(list[0], list)
    const rc1 = JSON.stringify(pipe().roughCut)
    ps().removeClip(project().clips[0].id)
    ps().undo()
    expect(JSON.stringify(pipe().roughCut)).toBe(rc1)
    ps().undo()
    expect(JSON.stringify(pipe().roughCut)).toBe(rc0)
    ps().redo()
    expect(JSON.stringify(pipe().roughCut)).toBe(rc1)
  })
})

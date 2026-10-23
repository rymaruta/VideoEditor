// 範囲の自動編集を「試しに見る」間に終わった裏の処理(ノイズ除去・BPM の解析 など)の結果は、試しが
// 終わる(閉じる・決める)のを待って当てる。企画を切り替えたら当てない。試していなければすぐ当てる
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
import { applyWhenNotTrying, useProjectStore } from '@renderer/store/projectStore'
import {
  DEFAULT_RANGED_OPTIONS,
  mainLength,
  type RangedPreview
} from '@renderer/lib/rangedAutoEdit'
import type { BeatGrid } from '@shared/types'
import { episode2, project } from './h'

const pipe = (): ReturnType<typeof usePipelineStore.getState> => usePipelineStore.getState()
const ps = (): ReturnType<typeof useProjectStore.getState> => useProjectStore.getState()
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function vars(): Promise<RangedPreview[]> {
  const total = mainLength(project())
  const r = await pipe().prepareRangedVariants(
    { start: total * 0.2, end: total * 0.8 },
    DEFAULT_RANGED_OPTIONS
  )
  if (!r.ok) throw new Error(r.reason)
  return r.previews
}

/** ノイズ除去の結果を当てる(MediaBin の denoiseAsset と同じ呼び方) */
function denoiseDone(session = ps().projectSession): { id: string; cleaned: string } {
  const asset = project().assets[0]
  const cleaned = '/tmp/denoised.wav'
  applyWhenNotTrying(
    () =>
      ps().setAssetsDenoised(
        { [asset.id]: cleaned },
        { expectFilePath: { [asset.id]: asset.filePath } }
      ),
    session
  )
  return { id: asset.id, cleaned }
}
const filePathOf = (id: string): string | undefined =>
  project().assets.find((a) => a.id === id)?.filePath

const GRID: BeatGrid = { bpm: 120, offsetSeconds: 0, enabled: true, sourceLabel: 'BGM' }

describe('試している間に終わった裏の処理の結果', () => {
  it('試しが無ければすぐ当たる', async () => {
    await episode2()
    const d = denoiseDone()
    expect(filePathOf(d.id)).toBe(d.cleaned)
  })

  it('試している間は当てず(断った数も増えない)、閉じた後に当たる', async () => {
    await episode2()
    const list = await vars()
    const base = project()
    pipe().tryRangedVariant(list[0], list)
    const trying = project()
    const refused = ps().trialRefused
    const d = denoiseDone()
    applyWhenNotTrying(() => ps().setBeatGrid(GRID))
    expect(project()).toBe(trying)
    expect(ps().trialRefused).toBe(refused)
    pipe().cancelRangedTrial()
    await settle()
    expect(ps().trial).toBeNull()
    expect(filePathOf(d.id)).toBe(d.cleaned)
    expect(project().beatGrid?.bpm).toBe(120)
    // 試しの案は残っていない(当てたのは試す前の企画の上)
    expect(project().clips).toBe(base.clips)
    expect(pipe().rangeReview).toBeNull()
  })

  it('決めた後に当たる(範囲の編集とは別の1件)', async () => {
    await episode2()
    const list = await vars()
    const past0 = ps().past.length
    pipe().tryRangedVariant(list[0], list)
    const d = denoiseDone()
    pipe().commitRangedVariant(list[0], list)
    await settle()
    expect(filePathOf(d.id)).toBe(d.cleaned)
    expect(ps().past.length).toBe(past0 + 2)
    // 取り消し1回でノイズ除去だけが戻り、もう1回で範囲の編集が戻る
    ps().undo()
    expect(filePathOf(d.id)).not.toBe(d.cleaned)
    expect(pipe().rangeReview?.current).toBe(list[0].variant.id)
  })

  it('待つ間に企画を切り替えたら当てない', async () => {
    await episode2()
    const list = await vars()
    pipe().tryRangedVariant(list[0], list)
    const asset = project().assets[0]
    denoiseDone()
    applyWhenNotTrying(() => ps().setBeatGrid(GRID))
    ps().newProject('別の企画')
    await settle()
    expect(ps().trial).toBeNull()
    expect(project().assets.some((a) => a.id === asset.id)).toBe(false)
    expect(project().beatGrid).toBeFalsy()
  })
})

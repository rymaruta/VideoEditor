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
import { sameExceptAutoEdit, useProjectStore } from '@renderer/store/projectStore'
import { sameProjectContent } from '@renderer/lib/projectEquality'
import {
  addRangedVariant,
  contentDifference,
  DEFAULT_RANGED_OPTIONS,
  mainLength,
  rangedVariantSpecs,
  sameRangedContent,
  type RangedEditOptions,
  type RangedPreview
} from '@renderer/lib/rangedAutoEdit'
import type { Project } from '@shared/types'
import { runEpisode } from '../helpers/episodeHarness'

async function episode(): Promise<void> {
  await runEpisode()
  usePipelineStore.getState().setTargetMinutes(1.5)
  await usePipelineStore.getState().rebuildRoughCut()
}

const project = (): Project => useProjectStore.getState().project

function middleRange(): { start: number; end: number } {
  const total = mainLength(project())
  return { start: total * 0.2, end: total * 0.8 }
}

async function variants(
  range = middleRange(),
  options: Partial<RangedEditOptions> = {}
): Promise<RangedPreview[]> {
  const r = await usePipelineStore
    .getState()
    .prepareRangedVariants(range, { ...DEFAULT_RANGED_OPTIONS, ...options })
  if (!r.ok) throw new Error(r.reason)
  return r.previews
}

/** 中身の比べ方の単体に使う、案の形だけのもの */
function fake(
  id: 'A' | 'B' | 'C',
  label: string,
  content: { start: number; end: number }[],
  cuts: number
): RangedPreview {
  const len = content.reduce((t, r) => t + r.end - r.start, 0)
  return {
    content,
    summary: { lengthAfter: len, cutsAfter: cuts },
    variant: { id, label, note: '', merged: [] }
  } as unknown as RangedPreview
}

/** 当てた企画が案の企画と同じか(自動編集の判断は当てる時の今のものを残す) */
const isApplied = (p: RangedPreview): boolean =>
  sameExceptAutoEdit(project(), { ...p.after, autoEdit: project().autoEdit })

describe('範囲の作り直しの案', () => {
  it('案の性格: 詰めるは間詰め強め・基準厳しめ・短め、残すはその逆。案A は今の設定のまま', () => {
    const [a, b, c] = rangedVariantSpecs('tempo')
    expect(a).toMatchObject({ id: 'A', policy: 'tempo', targetScale: 1, pauseScale: 1 })
    expect(b).toMatchObject({ id: 'B', label: '詰める', policy: 'highlights' })
    expect(b.pauseScale).toBeLessThan(1)
    expect(b.targetScale).toBeLessThan(1)
    expect(c).toMatchObject({ id: 'C', label: '残す', policy: 'light' })
    expect(c.pauseScale).toBeGreaterThan(1)
    expect(c.targetScale).toBeGreaterThan(1)
    // 端の方針はそれ以上ずらさない
    expect(rangedVariantSpecs('highlights')[1].policy).toBe('highlights')
    expect(rangedVariantSpecs('light')[2].policy).toBe('light')
  })

  it('中身がほぼ同じ案は1つにまとめ、まとめた名前を覚える', () => {
    const a = fake('A', '標準', [{ start: 0, end: 10 }], 3)
    const b = fake('B', '詰める', [{ start: 0.1, end: 10 }], 3)
    const c = fake('C', '残す', [{ start: 0, end: 16 }], 4)
    expect(contentDifference(a.content, b.content)).toBeCloseTo(0.1)
    expect(sameRangedContent(a, b)).toBe(true)
    expect(sameRangedContent(a, c)).toBe(false)
    let list = addRangedVariant([], a)
    list = addRangedVariant(list, b)
    list = addRangedVariant(list, c)
    expect(list.map((p) => p.variant.id)).toEqual(['A', 'C'])
    expect(list[0].variant.merged).toEqual(['詰める'])
    // 長さが同じでも、残す所が違えばまとめない
    const moved = fake('B', '詰める', [{ start: 20, end: 30 }], 3)
    expect(sameRangedContent(a, moved)).toBe(false)
  })

  it('実際の範囲で性格の違う案が出る(詰めるは短く、残すは長く)。案A は今の1案と同じ', async () => {
    await episode()
    const list = await variants()
    expect(list.length).toBeGreaterThanOrEqual(2)
    expect(list[0].variant.id).toBe('A')
    const a = list[0]
    const one = await usePipelineStore
      .getState()
      .prepareRangedEdit(middleRange(), DEFAULT_RANGED_OPTIONS)
    if (!one.ok) throw new Error(one.reason)
    expect(one.preview.summary.lengthAfter).toBeCloseTo(a.summary.lengthAfter, 6)
    expect(one.preview.content).toEqual(a.content)
    const b = list.find((p) => p.variant.id === 'B')
    const c = list.find((p) => p.variant.id === 'C')
    if (b) expect(b.summary.lengthAfter).toBeLessThan(a.summary.lengthAfter)
    if (c) expect(c.summary.lengthAfter).toBeGreaterThan(a.summary.lengthAfter)
    // 出した案どうしは、ほぼ同じ中身ではない
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        expect(sameRangedContent(list[i], list[j])).toBe(false)
  })

  it('カットをやり直さないときは1案だけ', async () => {
    await episode()
    const list = await variants(middleRange(), {
      steps: { ...DEFAULT_RANGED_OPTIONS.steps, cut: false }
    })
    expect(list.map((p) => p.variant.id)).toEqual(['A'])
  })

  it('選んだ案だけが当たり、取り消し1回で元に戻る', async () => {
    await episode()
    const base = project()
    const list = await variants()
    const pick = list[list.length - 1]
    const pastLen = useProjectStore.getState().past.length
    expect(usePipelineStore.getState().applyRangedEdit(pick, list).ok).toBe(true)
    expect(isApplied(pick)).toBe(true)
    for (const other of list.filter((p) => p !== pick)) expect(isApplied(other)).toBe(false)
    expect(useProjectStore.getState().past.length).toBe(pastLen + 1)
    const review = usePipelineStore.getState().rangeReview
    expect(review?.current).toBe(pick.variant.id)
    expect(review?.variants.length).toBe(list.length)
    useProjectStore.getState().undo()
    expect(sameProjectContent({ ...project(), autoEdit: base.autoEdit }, base)).toBe(true)
    expect(project().clips).toBe(base.clips)
  })

  it('当てた後に別の案に替える: 履歴は1件のまま、取り消し1回で当てる前に戻る', async () => {
    await episode()
    const base = project()
    const list = await variants()
    expect(list.length).toBeGreaterThanOrEqual(2)
    const [first, second] = list
    const pastLen = useProjectStore.getState().past.length
    usePipelineStore.getState().applyRangedEdit(first, list)
    const runs = usePipelineStore.getState().rangeRuns.length
    expect(usePipelineStore.getState().switchRangedVariant(second)).toEqual({ ok: true })
    expect(isApplied(second)).toBe(true)
    expect(useProjectStore.getState().past.length).toBe(pastLen + 1)
    expect(useProjectStore.getState().future.length).toBe(0)
    expect(usePipelineStore.getState().rangeReview?.current).toBe(second.variant.id)
    // 範囲の自動編集の記録は、替えた案の1件だけ
    expect(usePipelineStore.getState().rangeRuns.length).toBe(runs)
    // 前を見ている間(取り消した)に替えても、履歴は1件
    useProjectStore.getState().undo()
    expect(project().clips).toBe(base.clips)
    expect(usePipelineStore.getState().switchRangedVariant(first).ok).toBe(true)
    expect(isApplied(first)).toBe(true)
    expect(useProjectStore.getState().past.length).toBe(pastLen + 1)
    useProjectStore.getState().undo()
    expect(sameProjectContent({ ...project(), autoEdit: base.autoEdit }, base)).toBe(true)
  })

  it('用意している間・当てた後に別の編集をしたら、案を当てない・替えない', async () => {
    await episode()
    const list = await variants()
    const c = project().clips[0]
    useProjectStore.getState().updateClipTrim(c.id, c.inPoint, c.outPoint - 1)
    const edited = project()
    const r = usePipelineStore.getState().applyRangedEdit(list[1] ?? list[0], list)
    expect(r.ok).toBe(false)
    expect(project()).toBe(edited)

    await episode()
    const again = await variants()
    expect(again.length).toBeGreaterThanOrEqual(2)
    usePipelineStore.getState().applyRangedEdit(again[0], again)
    // 本編のクリップはそのままで、テロップだけ直した
    const t = project().textOverlays[0]
    useProjectStore.getState().updateTextOverlay(t.id, { text: t.text + '!' })
    const touched = project()
    const s = usePipelineStore.getState().switchRangedVariant(again[1])
    expect(s.ok).toBe(false)
    expect(s.reason).toContain('編集した')
    expect(project()).toBe(touched)
  })

  it('閉じたら(止めたら)残りの案を作らない', async () => {
    await episode()
    const signal = { aborted: false }
    const seen: number[] = []
    const r = await usePipelineStore
      .getState()
      .prepareRangedVariants(middleRange(), DEFAULT_RANGED_OPTIONS, {
        signal,
        onVariant: (list) => {
          seen.push(list.length)
          signal.aborted = true
        }
      })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.canceled).toBe(true)
    expect(seen).toEqual([1])
    expect(usePipelineStore.getState().rangeReview).toBeNull()
  })

  it('案を1つずつ出し、案と案の間で一度ほかの処理に戻る(固まらない)', async () => {
    await episode()
    let ticks = 0
    const timer = setInterval(() => ticks++, 0)
    const seen: number[] = []
    const r = await usePipelineStore
      .getState()
      .prepareRangedVariants(middleRange(), DEFAULT_RANGED_OPTIONS, {
        onVariant: () => seen.push(ticks)
      })
    clearInterval(timer)
    expect(r.ok).toBe(true)
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen[1]).toBeGreaterThan(seen[0])
  })
})

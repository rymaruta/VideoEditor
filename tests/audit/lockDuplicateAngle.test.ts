// 同じ共通の時刻を本編が2回映す(クリップを複製した)とき、片方だけ手でカメラを替えてロックし、
// 作り直しても、複製は両方とも、中身・カメラ・置いた所のまま残る(variantFuzz の seed 52・129 で見つかった)。
// ロックの窓が本編で続いて並んでいない(複製が離れた所にある)と、前はロックの中を前のクリップに差し替えず、
// 窓の中の今の中身(区間とカメラ)を固定して組み直していた。作り直した本編は同じ時刻を1回しか映せないので、
// 複製は1本に減り、カメラも1つに潰れて手で決めたカメラが消えていた。今はロックの中のクリップを、続いて並ぶ
// 塊ごとにそのまま差し戻す(離れた塊は、前の本編で直前にあったクリップの終わりを目印に置き直す)
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
import { angleAlternatives, coverageOfClips, type CameraSeg } from '@shared/roughCut/overrides'
import type { Clip } from '@shared/types'
import { DEFAULT_RANGED_OPTIONS } from '@renderer/lib/rangedAutoEdit'
import { clipTimes } from '@shared/roughCut/range'
import { cov, episode2, len, project } from './h'

/** 本編の真ん中あたりの、別のカメラに替えられるクリップと、替え先のカメラ */
function pickClip(): { clip: Clip; seg: CameraSeg; other: string } {
  const p = project()
  const info = p.multicam!
  const order = p.clips.map((_, i) => i)
  order.sort((a, b) => Math.abs(a - p.clips.length / 2) - Math.abs(b - p.clips.length / 2) || a - b)
  for (const i of order) {
    const clip = p.clips[i]
    const seg = coverageOfClips([clip], info)[0]
    if (!seg || seg.end - seg.start < 1) continue
    const alt = angleAlternatives(clip, info).find((a) => !a.current && (a.clips?.length ?? 0) > 0)
    if (alt) return { clip, seg, other: alt.sourceId }
  }
  throw new Error('替えられるクリップがありません')
}

/** 本編のうち、`seg` の共通の時刻を映す区間(複製ごとに1つ) */
const showing = (seg: CameraSeg): CameraSeg[] =>
  cov()
    .map((s) => ({
      start: Math.max(s.start, seg.start),
      end: Math.min(s.end, seg.end),
      cameraId: s.cameraId
    }))
    .filter((s) => s.end - s.start > 0.02)

describe('同じ時刻を2回映す本編で、片方だけ手で決めたカメラをロックして作り直す', () => {
  for (const which of ['前に並んだ複製', '後ろに並んだ複製'] as const)
    it(`離れて並んだ2つのうち${which}のカメラを替えても、作り直しで複製が両方、中身もカメラもそのまま残る`, async () => {
      await episode2()
      const { clip, seg, other } = pickClip()
      const s = useProjectStore.getState()
      s.duplicateClips([clip.id])
      const copyId = useProjectStore.getState().selectedClipId!
      // 複製を頭へ動かす(ロックの窓の中を映すクリップが、本編で続いて並ばない)
      useProjectStore.getState().moveClipToIndex(copyId, 0)
      expect(project().clips[0].id).toBe(copyId)
      const target = which === '前に並んだ複製' ? copyId : clip.id
      useProjectStore.getState().switchClipAngle(target, other)
      // 同じ時刻を、手で替えたカメラと組んだ本編のままのカメラの両方で映している(並びの順)
      const before = showing(seg)
      expect(before.map((x) => x.cameraId).sort()).toEqual([other, seg.cameraId].sort())
      const headCam = before[0].cameraId
      useProjectStore.getState().addAutoEditLock({ start: seg.start, end: seg.end })
      await usePipelineStore.getState().rebuildRoughCut()
      // 複製は両方とも残り、並びの順・区間・カメラは前のまま
      const same = (): void => {
        const after = showing(seg)
        expect(after.map((x) => x.cameraId)).toEqual(before.map((x) => x.cameraId))
        after.forEach((x, k) => {
          expect(x.start).toBeCloseTo(before[k].start, 3)
          expect(x.end).toBeCloseTo(before[k].end, 3)
        })
        // 頭に置いた複製は頭のまま(ロックの所へ寄せない)
        const head = coverageOfClips([project().clips[0]], project().multicam!)[0]
        expect(head.cameraId).toBe(headCam)
        expect(head.start).toBeCloseTo(seg.start, 3)
      }
      same()
      // もう一度作り直しても変わらない
      await usePipelineStore.getState().rebuildRoughCut()
      same()
    })

  it('続いて並んだ2つ(ロックの窓が本編で続く)なら、2つともそのままのカメラで残る', async () => {
    await episode2()
    const { clip, seg, other } = pickClip()
    useProjectStore.getState().duplicateClips([clip.id])
    const copyId = useProjectStore.getState().selectedClipId!
    useProjectStore.getState().switchClipAngle(clip.id, other)
    useProjectStore.getState().addAutoEditLock({ start: seg.start, end: seg.end })
    const cams = (): string[] => showing(seg).map((x) => x.cameraId)
    expect(cams()).toEqual([other, seg.cameraId])
    await usePipelineStore.getState().rebuildRoughCut()
    // 複製の両方が、それぞれのカメラで残る
    expect(cams()).toEqual([other, seg.cameraId])
    expect(project().clips.some((c) => c.id === copyId)).toBe(true)
  })
})

// a5dbe9c の監査(zLockAudit・zLockAudit2)から
describe('同じ時刻を2回映す本編の監査', () => {
  for (const where of ['頭', '終わり'] as const)
    it(`S1 範囲の自動編集(アングルをやり直さない): 範囲の外の複製(${where})だけ手で替えても、範囲の中のカメラはそのまま`, async () => {
      await episode2()
      const { clip, seg, other } = pickClip()
      useProjectStore.getState().duplicateClips([clip.id])
      const copyId = useProjectStore.getState().selectedClipId!
      useProjectStore
        .getState()
        .moveClipToIndex(copyId, where === '頭' ? 0 : project().clips.length - 1)
      useProjectStore.getState().switchClipAngle(copyId, other)
      const p = project()
      const i = p.clips.findIndex((c) => c.id === clip.id)
      const t = clipTimes(p.clips)[i]
      const r = await usePipelineStore
        .getState()
        .prepareRangedEdit(
          { start: t.start, end: t.end },
          { ...DEFAULT_RANGED_OPTIONS, steps: { ...DEFAULT_RANGED_OPTIONS.steps, angles: false } },
          { exact: true }
        )
      if (!r.ok) throw new Error(r.reason)
      expect(usePipelineStore.getState().applyRangedEdit(r.preview).ok).toBe(true)
      const q = project()
      const tt = clipTimes(q.clips)
      const mid = (t.start + t.end) / 2
      const k = q.clips.findIndex((_, j) => tt[j].start <= mid && tt[j].end > mid)
      const cam = q.multicam!.files.find((f) => f.assetId === q.clips[k].assetId)!.sourceId
      // 範囲の中は今のカメラ(元のカメラ)のまま、外の複製は手で替えたカメラのまま
      expect(cam).toBe(seg.cameraId)
      expect(
        showing(seg)
          .map((x) => x.cameraId)
          .sort()
      ).toEqual([other, seg.cameraId].sort())
    })

  // S2: ロックの中の複製の片方を「組んだ本編と同じカメラ」へ戻した判断は、今の記録(組んだ本編・
  // 覚えている手直し)からは「手を付けていない方」と見分けられない。ロックの中のクリップを複製ごとそのまま
  // 差し戻すので、カメラを選ばずに両方残る
  for (const where of ['頭', '終わり'] as const)
    it(`S2 ロック: 手で替えて作り直した後、複製(${where})を組んだ本編のカメラへ戻すと、戻した判断が残る`, async () => {
      await episode2()
      const { clip, seg, other } = pickClip()
      useProjectStore.getState().switchClipAngle(clip.id, other)
      useProjectStore.getState().addAutoEditLock({ start: seg.start, end: seg.end })
      await usePipelineStore.getState().rebuildRoughCut()
      const p = project()
      const mid = (seg.start + seg.end) / 2
      const c = p.clips.find((x) =>
        coverageOfClips([x], p.multicam!).some((s) => s.start < mid && s.end > mid)
      )!
      useProjectStore.getState().duplicateClips([c.id])
      const copyId = useProjectStore.getState().selectedClipId!
      useProjectStore
        .getState()
        .moveClipToIndex(copyId, where === '頭' ? 0 : project().clips.length - 1)
      useProjectStore.getState().switchClipAngle(copyId, seg.cameraId)
      const before = showing(seg).map((x) => x.cameraId)
      expect(before.sort()).toEqual([other, seg.cameraId].sort())
      await usePipelineStore.getState().rebuildRoughCut()
      // 戻した判断(組んだ本編のカメラ)も、前に手で替えたカメラも残る
      expect(
        showing(seg)
          .map((x) => x.cameraId)
          .sort()
      ).toEqual(before)
    })

  it('S3 速さを変えた複製を手で替えてロックしても、手のカメラが残る', async () => {
    await episode2()
    const { clip, seg, other } = pickClip()
    useProjectStore.getState().duplicateClips([clip.id])
    const copyId = useProjectStore.getState().selectedClipId!
    useProjectStore.getState().moveClipToIndex(copyId, 0)
    useProjectStore.getState().switchClipAngle(copyId, other)
    useProjectStore.getState().updateClipSpeed(project().clips[0].id, 2)
    expect(project().clips[0].speed).toBe(2)
    useProjectStore.getState().addAutoEditLock({ start: seg.start, end: seg.end })
    await usePipelineStore.getState().rebuildRoughCut()
    // 速さを変えた複製(頭)も、そのままの速さ・カメラで頭に残る。元のクリップも残る
    const head = project().clips[0]
    expect(head.speed).toBe(2)
    expect(coverageOfClips([head], project().multicam!)[0].cameraId).toBe(other)
    const after = showing(seg)
    expect(after.map((x) => x.cameraId)).toEqual([other, seg.cameraId])
    for (const x of after) expect(len([x])).toBeCloseTo(seg.end - seg.start, 1)
  })
})

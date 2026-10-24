// 同じ共通の時刻を本編が2回映す(クリップを複製した)とき、片方だけ手でカメラを替えてロックし、
// 作り直しても手で決めたカメラが残る(variantFuzz の seed 52・129 で見つかった)。
// ロックの窓が本編で続いて並んでいない(複製が離れた所にある)と、ロックの中は前のクリップの差し替えに
// ならず、窓の中の今の中身(区間とカメラ)を固定して組み直す。そのとき同じ時刻の2つのカメラが1つに
// 潰れ、並びの後ろの方(組んだ本編のままのカメラ)が勝って、手で決めたカメラが消えていた
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
    it(`離れて並んだ2つのうち${which}のカメラを替えても、作り直しで手のカメラが残る`, async () => {
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
      // 同じ時刻を、手で替えたカメラと組んだ本編のままのカメラの両方で映している
      const before = showing(seg)
      expect(before.map((x) => x.cameraId).sort()).toEqual([other, seg.cameraId].sort())
      useProjectStore.getState().addAutoEditLock({ start: seg.start, end: seg.end })
      await usePipelineStore.getState().rebuildRoughCut()
      const after = showing(seg)
      // ロックの中身(区間)は保たれ、カメラは手で決めた方
      expect(len(after)).toBeCloseTo(seg.end - seg.start, 1)
      expect(after.length).toBeGreaterThan(0)
      for (const x of after) expect(x.cameraId).toBe(other)
      // もう一度作り直しても変わらない
      await usePipelineStore.getState().rebuildRoughCut()
      for (const x of showing(seg)) expect(x.cameraId).toBe(other)
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

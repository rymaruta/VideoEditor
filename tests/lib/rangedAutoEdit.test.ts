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
import { useSettingsStore } from '@renderer/store/settingsStore'
import { sameProjectContent } from '@renderer/lib/projectEquality'
import {
  DEFAULT_RANGED_OPTIONS,
  mainLength,
  type RangedEditOptions,
  type RangedPreview
} from '@renderer/lib/rangedAutoEdit'
import type { Project } from '@shared/types'
import { clipTimes, commonWindowOf, timelineWindowOf } from '@shared/roughCut/range'
import {
  coverageOfClips,
  subtractRanges,
  unionRanges,
  updateOverrides
} from '@shared/roughCut/overrides'
import { markIn, markOut, rippleDelete } from '@renderer/lib/editCommands'
import { currentTimelineRange } from '@renderer/lib/timelineRange'
import { cutSignature } from '@shared/autoEdit'
import { runEpisode } from '../helpers/episodeHarness'

const KIT = {
  se: {
    ツッコミ: [{ path: '/kit/SE/ツッコミ/a.wav', name: 'a.wav', duration: 1.2 }],
    場面転換: [{ path: '/kit/SE/場面転換/b.wav', name: 'b.wav', duration: 0.8 }]
  },
  bgm: {
    楽しい: [{ path: '/kit/BGM/楽しい/c.mp3', name: 'c.mp3', duration: 40 }],
    穏やか: [{ path: '/kit/BGM/穏やか/d.mp3', name: 'd.mp3', duration: 25 }]
  },
  cg: {}
}

async function episode(): Promise<void> {
  await runEpisode(() => useSettingsStore.setState({ showKitFolder: '/kit' } as never), {
    showKitScan: async () => KIT,
    probeMedia: async (path: string) => ({
      duration: path.startsWith('/kit') ? 40 : 240,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      hasVideo: !path.endsWith('.wav') && !path.endsWith('.mp3'),
      videoCodec: 'h264',
      audioCodec: 'aac',
      needsPreviewProxy: false
    })
  })
  // 長さの目標で場面を落とし、範囲の自動編集で戻る所を作る
  usePipelineStore.getState().setTargetMinutes(1.5)
  await usePipelineStore.getState().rebuildRoughCut()
}

const project = (): Project => useProjectStore.getState().project

function middleRange(): { start: number; end: number } {
  const total = mainLength(project())
  return { start: total * 0.3, end: total * 0.6 }
}

async function rangedEdit(
  range: { start: number; end: number },
  options: Partial<RangedEditOptions> = {}
): Promise<RangedPreview> {
  const r = await usePipelineStore
    .getState()
    .prepareRangedEdit(range, { ...DEFAULT_RANGED_OPTIONS, ...options })
  if (!r.ok) throw new Error(r.reason)
  return r.preview
}

describe('範囲だけ自動編集する', () => {
  it('範囲の外のクリップは同じオブジェクトのまま、取り消し1回で元の企画に戻る', async () => {
    await episode()
    const base = project()
    const preview = await rangedEdit(middleRange())
    const times = clipTimes(base.clips)
    const before = base.clips.filter((_, i) => times[i].end <= preview.range.start + 1e-6)
    const after = base.clips.filter((_, i) => times[i].start >= preview.range.end - 1e-6)
    expect(usePipelineStore.getState().applyRangedEdit(preview).ok).toBe(true)
    const now = project()
    for (const c of before) expect(now.clips.find((x) => x.id === c.id)).toBe(c)
    for (const c of after) expect(now.clips.find((x) => x.id === c.id)).toBe(c)
    expect(useProjectStore.getState().past.at(-1)).toBe(base)
    useProjectStore.getState().undo()
    // 自動編集の判断(`autoEdit`)は取り消しの履歴に積まない(画面の判断と食い違わないように)
    expect(sameProjectContent({ ...project(), autoEdit: base.autoEdit }, base)).toBe(true)
    expect(project().clips).toBe(base.clips)
  })

  it('用意している間に本編が直されたら当てない', async () => {
    await episode()
    const preview = await rangedEdit(middleRange())
    const c = project().clips[0]
    useProjectStore.getState().updateClipTrim(c.id, c.inPoint, c.outPoint - 1)
    const edited = project()
    const r = usePipelineStore.getState().applyRangedEdit(preview)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('本編が直された')
    expect(project()).toBe(edited)
  })

  it('範囲の後に全体を作り直しても、範囲の中に人の修正が増えない', async () => {
    await episode()
    const preview = await rangedEdit(middleRange())
    usePipelineStore.getState().applyRangedEdit(preview)
    const p = project()
    const read = updateOverrides(
      p.cutOverrides,
      p.roughCutAuto!,
      coverageOfClips(p.clips, p.multicam!)
    )
    const inside = (r: { start: number; end: number }): boolean =>
      r.end > preview.window.start + 1e-3 && r.start < preview.window.end - 1e-3
    expect(read.removed.filter(inside)).toEqual([])
    expect(read.added.filter(inside)).toEqual([])
    expect(read.angles.filter(inside)).toEqual([])
    // 組んだ本編の印に、この回の残した場面が付いている
    const sig = cutSignature(p.roughCutAuto)
    expect(usePipelineStore.getState().builtKept.at(-1)?.cut).toBe(sig)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(project().cutOverrides).toEqual(p.cutOverrides)
    expect(usePipelineStore.getState().rangeRuns).toEqual([])
  })

  it('長さを保つと、範囲より後ろは1フレームも動かない', async () => {
    await episode()
    const base = project()
    const range = middleRange()
    const preview = await rangedEdit(range, { keepLength: true })
    expect(preview.newRange.end - preview.newRange.start).toBeCloseTo(
      preview.range.end - preview.range.start,
      6
    )
    usePipelineStore.getState().applyRangedEdit(preview)
    expect(mainLength(project())).toBeCloseTo(mainLength(base), 6)
    // 範囲より後ろの声・テロップは同じ時刻
    const late = (p: typeof base): (string | number)[][] =>
      p.textOverlays
        .filter((o) => o.startTime >= preview.range.end + 0.5)
        .map((o) => [o.text, +o.startTime.toFixed(6)])
        .sort()
    expect(late(project())).toEqual(late(base))
  })

  it('手を入れた自動のトラックは、範囲で置き直さず残す', async () => {
    await episode()
    const bgm = project().audioTracks.find((t) => t.autoRole === 'bgm')!
    // BGM の1本を手で消す(手を入れた印)
    useProjectStore.getState().removeAudioClip(bgm.id, bgm.clips[0].id)
    const edited = project().audioTracks.find((t) => t.autoRole === 'bgm')!
    const preview = await rangedEdit(middleRange(), {
      steps: { ...DEFAULT_RANGED_OPTIONS.steps, bgm: true }
    })
    expect(preview.summary.skipped).toContain('BGM')
    usePipelineStore.getState().applyRangedEdit(preview)
    const now = project().audioTracks.find((t) => t.autoRole === 'bgm')!
    // 手を入れたトラックは「手を入れた」のまま(作り直しで消さない)、本編に付いていくだけ
    expect(now.autoSignature).toBe(edited.autoSignature)
    expect(now.clips.length).toBeGreaterThanOrEqual(edited.clips.length - 1)
    // 手を入れていない SE のトラックは、置き直した後も「手を入れていない」
    const se = project().audioTracks.find((t) => t.autoRole === 'se')
    if (se) expect(se.autoSignature).toBeDefined()
  })

  it('乱択: 範囲より前の声・テロップ・SE はそのまま、後ろはリップルで長さの変わりだけ動き、長さを保てば動かない', async () => {
    let seed = 11
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    for (let n = 0; n < 6; n++) {
      await episode()
      const total0 = mainLength(project())
      const start = rand() * total0 * 0.6
      const end0 = Math.min(total0, start + 8 + rand() * total0 * 0.4)
      // 範囲の中のクリップを1本手で消す(範囲の自動編集で戻り、範囲の長さが変わる)
      const t0 = clipTimes(project().clips)
      const victim = project().clips.find(
        (_, i) => t0[i].start > start + 0.5 && t0[i].end < end0 - 0.5
      )
      let end = end0
      if (victim) {
        const i = project().clips.indexOf(victim)
        end -= t0[i].end - t0[i].start
        useProjectStore.getState().removeClip(victim.id)
      }
      const base = project()
      const total = mainLength(base)
      const keepLength = n % 2 === 1
      let preview
      try {
        preview = await rangedEdit({ start, end }, { keepLength })
      } catch (e) {
        // 範囲の素材で長さを埋めきれない・残す所が無い範囲は、当てずに理由を返す
        expect(String(e)).toMatch(/足りません|残す所がありません/)
        continue
      }
      usePipelineStore.getState().applyRangedEdit(preview)
      const after = project()
      const a = preview.range.start
      const b = preview.range.end
      const delta = preview.newRange.end - preview.newRange.start - (b - a)
      if (keepLength) expect(Math.abs(delta)).toBeLessThan(1e-6)
      else if (victim) expect(delta).toBeGreaterThan(0.1)
      void total
      type Timed = { startTime: number; endTime?: number; inPoint?: number; outPoint?: number }
      const items = (p: typeof base): (Timed & { key: string })[] => [
        ...p.audioTracks.flatMap((t) =>
          t.clips.map((c) => ({
            key: `${t.name}|${c.assetId}|${c.inPoint.toFixed(6)}`,
            startTime: c.startTime,
            endTime: c.startTime + (c.outPoint - c.inPoint) / (c.speed || 1)
          }))
        ),
        ...p.textOverlays.map((o) => ({
          key: `t|${o.text}`,
          startTime: o.startTime,
          endTime: o.endTime
        }))
      ]
      const fmt = (list: (Timed & { key: string })[], shift: number): string[] =>
        list.map((x) => `${x.key}@${(x.startTime + shift).toFixed(5)}`).sort()
      const beforeOld = items(base).filter((x) => (x.endTime ?? x.startTime) <= a - 1e-3)
      const beforeNew = items(after).filter((x) => (x.endTime ?? x.startTime) <= a - 1e-3)
      expect(fmt(beforeNew, 0)).toEqual(fmt(beforeOld, 0))
      const afterOld = items(base).filter((x) => x.startTime >= b + 1e-3)
      const afterNew = items(after).filter((x) => x.startTime >= b + delta + 1e-3)
      expect(fmt(afterNew, 0)).toEqual(fmt(afterOld, delta))
    }
  })

  it('ロックした所は、全体を作り直しても声・自動テロップ・SE・BGM が前のまま(置かれた所へずれるだけ)', async () => {
    await episode()
    const info = project().multicam!
    const total = mainLength(project())
    const cw = commonWindowOf(project().clips, info, { start: total * 0.35, end: total * 0.65 })
    expect(cw.ok).toBe(true)
    if (!cw.ok) return
    useProjectStore.getState().addAutoEditLock(cw.window)
    const lock = cw.window
    const snapshot = (): string[] => {
      const p = project()
      const w = timelineWindowOf(p.clips, p.multicam!, lock)!
      const rel = (t: number): string => (t - w.start).toFixed(4)
      const inW = (t: number): boolean => t >= w.start + 0.05 && t < w.end - 0.05
      return [
        ...p.audioTracks.flatMap((t) =>
          t.clips
            .filter((c) => inW(c.startTime))
            .map(
              (c) =>
                `${t.autoRole ?? t.multicamSourceId}|${c.assetId}|${rel(c.startTime)}|${c.inPoint.toFixed(4)}`
            )
        ),
        ...p.textOverlays
          .filter((o) => o.utteranceId && inW((o.startTime + o.endTime) / 2))
          .map((o) => `t|${o.text}|${rel(o.startTime)}`)
      ].sort()
    }
    const before = snapshot()
    expect(before.some((x) => x.startsWith('t|'))).toBe(true)
    // 長さの目標を変えて全体を作り直す(ロックの外の場面の残し方が変わる)
    usePipelineStore.getState().setTargetMinutes(2.5)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(snapshot()).toEqual(before)
  })

  describe('イン点・アウト点(I / O)で決めた範囲', () => {
    /** I / O のキーと同じ操作でイン点・アウト点を打つ */
    const markRange = (a: number, b: number): void => {
      useProjectStore.getState().seekTo(a)
      markIn()
      useProjectStore.getState().seekTo(b)
      markOut()
    }
    const ioRange = (): { start: number; end: number } => {
      const st = useProjectStore.getState()
      const picked = currentTimelineRange({
        timelineIn: st.timelineIn,
        timelineOut: st.timelineOut,
        dragRange: st.dragRange,
        multiSelectedClipIds: st.multiSelectedClipIds,
        project: st.project
      })
      expect(picked?.origin).toBe('marks')
      return picked!.range
    }

    it('I〜O の範囲をそのまま自動編集し、取り消し1回で戻る', async () => {
      await episode()
      const total = mainLength(project())
      const a = Math.round(total * 0.3 * 30) / 30
      const b = Math.round(total * 0.6 * 30) / 30
      markRange(a, b)
      expect(ioRange()).toEqual({ start: a, end: b })
      const base = project()
      const r = await usePipelineStore
        .getState()
        .prepareRangedEdit(ioRange(), DEFAULT_RANGED_OPTIONS, { exact: true })
      if (!r.ok) throw new Error(r.reason)
      // 境を静かな所へ寄せない(イン点・アウト点のまま)
      expect(r.preview.range).toEqual({ start: a, end: b })
      expect(usePipelineStore.getState().applyRangedEdit(r.preview).ok).toBe(true)
      expect(project()).not.toBe(base)
      useProjectStore.getState().undo()
      expect(project().clips).toBe(base.clips)
      expect(sameProjectContent({ ...project(), autoEdit: base.autoEdit }, base)).toBe(true)
      // イン点・アウト点は取り消しの履歴に積まない(打ったまま)
      expect(useProjectStore.getState().timelineIn).toBe(a)
      expect(useProjectStore.getState().timelineOut).toBe(b)
    })

    it('Shift+Delete(I〜O を抜く)と同じ範囲を使う: 抜く所と範囲の自動編集の窓の中身が一致する', async () => {
      await episode()
      const total = mainLength(project())
      markRange(total * 0.25, total * 0.55)
      const range = ioRange()
      const base = project()
      const info = base.multicam!
      const r = await usePipelineStore
        .getState()
        .prepareRangedEdit(range, DEFAULT_RANGED_OPTIONS, { exact: true })
      if (!r.ok) throw new Error(r.reason)
      const cw = commonWindowOf(base.clips, info, range)
      if (!cw.ok) throw new Error(cw.reason)
      expect(r.preview.window).toEqual(cw.window)
      // 当てずに、同じ I〜O を Shift+Delete で抜く
      useProjectStore.getState().selectClip(null)
      expect(rippleDelete()).toBe(true)
      const after = project()
      expect(mainLength(after)).toBeCloseTo(total - (range.end - range.start), 6)
      const removed = subtractRanges(
        coverageOfClips(base.clips, info),
        coverageOfClips(after.clips, info)
      )
      const windowed = unionRanges(cw.pieces.map((p) => ({ start: p.start, end: p.end })))
      expect(removed.length).toBe(windowed.length)
      removed.forEach((x, i) => {
        expect(x.start).toBeCloseTo(windowed[i].start, 4)
        expect(x.end).toBeCloseTo(windowed[i].end, 4)
      })
      // 抜いた後は用意した範囲の自動編集を当てない(本編が変わった)
      expect(usePipelineStore.getState().applyRangedEdit(r.preview).ok).toBe(false)
    })
  })
})

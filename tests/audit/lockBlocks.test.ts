// ロックの窓の中を映すクリップが本編で続いて並んでいない(複製・並べ替え)とき、作り直しても、ロックの中は
// 続いて並ぶ塊ごとにそのまま残る。元の所の塊は作り直した本編の窓の所へ、離れた塊(頭に置いた予告の複製など)は
// 前の本編で直前にあった収録素材のクリップの終わりを目印に置き直す(差し込みの画と同じ置き方)。
// 声・ワイプ・自動テロップ・SE/BGM も、塊ごとにその塊の置かれた所へずれて残る
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
import { lockRangesOf } from '@renderer/lib/timelineRange'
import { mainHardCuts } from '@renderer/lib/transcriptTimeline'
import { coverageOfClips, type Range } from '@shared/roughCut/overrides'
import {
  clipTimes,
  matchLockBlocks,
  timelineBlocksOf,
  type TimelineRange
} from '@shared/roughCut/range'
import type { RoughCut } from '@shared/roughCut/build'
import { toCommon } from '@shared/sync/multicam'
import type { Clip, Project } from '@shared/types'
import { flush, stubApi } from '../helpers/episodeHarness'
import { KIT, episode2, project } from './h'

/** 顔カメラ(ワイプ)のあるゲーム実況の回。声・ワイプ・発言テロップ・SE・BGM がそろう */
async function gameEpisode(): Promise<void> {
  stubApi({
    showKitScan: async () => KIT,
    syncRun: async () => ({
      placements: [
        { id: '/r/a.mp4', start: 0, method: 'reference', rate: 1 },
        { id: '/r/b.mp4', start: 0, method: 'audio', rate: 1 },
        { id: '/r/c.mp4', start: 0, method: 'audio', rate: 1 }
      ],
      issues: [],
      pairs: [],
      elapsedMs: 1
    }),
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
  useSettingsStore.setState({
    aiProvider: 'off',
    episodeKind: 'game',
    showKitFolder: '/kit'
  } as never)
  useProjectStore.getState().newProject('第1回')
  await flush()
  const file = (
    p: string
  ): { path: string; relativePath: string; duration: number; hasVideo: true; hasAudio: true } => ({
    path: p,
    relativePath: p.slice(3),
    duration: 240,
    hasVideo: true,
    hasAudio: true
  })
  usePipelineStore.setState({
    running: false,
    root: '/r',
    scanTracks: true,
    scan: { root: '/r', sources: [], skipped: [], stats: {} },
    sources: [
      { id: 'cam', name: 'カメラA', kind: 'camera', basis: '', files: [file('/r/a.mp4')] },
      { id: 'camb', name: 'カメラB', kind: 'camera', basis: '', files: [file('/r/b.mp4')] },
      {
        id: 'face',
        name: '顔',
        kind: 'camera',
        cameraRole: 'face',
        basis: '',
        files: [file('/r/c.mp4')]
      }
    ]
  } as never)
  await usePipelineStore.getState().runPipeline()
  usePipelineStore.getState().setTargetMinutes(1.5)
  await usePipelineStore.getState().rebuildRoughCut()
}

const r4 = (t: number): string => t.toFixed(3)

/**
 * 塊(タイムラインの区間)の中身を、塊の頭からの時刻で書き出す: 声・SE・BGM(区間で切った所と、
 * その所の素材の位置)、ワイプ、自動テロップ(区間で切った所)
 */
function snapshot(p: Project, w: TimelineRange): string[] {
  const cut = (start: number, end: number): [number, number] | null => {
    const a = Math.max(start, w.start)
    const b = Math.min(end, w.end)
    return b - a > 0.05 ? [a, b] : null
  }
  const timed = <
    C extends { startTime: number; inPoint: number; outPoint: number; speed?: number }
  >(
    tag: string,
    c: C
  ): string[] => {
    const sp = c.speed || 1
    const x = cut(c.startTime, c.startTime + (c.outPoint - c.inPoint) / sp)
    if (!x) return []
    const at = c.inPoint + (x[0] - c.startTime) * sp
    return [`${tag}|${r4(x[0] - w.start)}|${r4(x[1] - w.start)}|${r4(at)}`]
  }
  return [
    ...p.audioTracks.flatMap((t) =>
      t.clips.flatMap((c) =>
        timed(`${t.multicamSourceId ? 'v:' + t.multicamSourceId : t.autoRole}|${c.assetId}`, c)
      )
    ),
    ...p.videoOverlayTracks.flatMap((t) =>
      t.clips.flatMap((c) => timed(`w:${t.multicamSourceId ?? t.autoRole}|${c.assetId}`, c))
    ),
    ...p.textOverlays.flatMap((o) => {
      if (!o.utteranceId && !o.effectId) return []
      const x = cut(o.startTime, o.endTime)
      return x ? [`t|${o.text}|${r4(x[0] - w.start)}|${r4(x[1] - w.start)}`] : []
    })
  ].sort()
}

/** 発言テロップのある、真ん中あたりのクリップ */
function clipWithTelop(): { clip: Clip; seg: Range } {
  const p = project()
  const t = clipTimes(p.clips)
  const order = p.clips.map((_, i) => i)
  order.sort((a, b) => Math.abs(a - p.clips.length / 2) - Math.abs(b - p.clips.length / 2) || a - b)
  for (const i of order) {
    const seg = coverageOfClips([p.clips[i]], p.multicam!)[0]
    if (!seg || seg.end - seg.start < 3) continue
    const has = p.textOverlays.some(
      (o) => o.utteranceId && o.startTime >= t[i].start && o.endTime <= t[i].end
    )
    if (has) return { clip: p.clips[i], seg }
  }
  throw new Error('発言テロップのあるクリップがありません')
}

/** 元のクリップを頭へ動かし、複製を元の所に残す(ロックの窓が続かない本編) */
async function splitLock(): Promise<{ seg: Range; before: Project }> {
  await gameEpisode()
  const { clip, seg } = clipWithTelop()
  useProjectStore.getState().duplicateClips([clip.id])
  useProjectStore.getState().moveClipToIndex(clip.id, 0)
  useProjectStore.getState().addAutoEditLock(seg)
  return { seg, before: project() }
}

describe('続かないロックの作り直し(塊ごとに差し戻す)', () => {
  it('声・ワイプ・テロップ・SE/BGM が、塊ごとにずれて正しい位置に残る', async () => {
    const { seg, before } = await splitLock()
    const info = before.multicam!
    const blocks0 = timelineBlocksOf(before.clips, info, seg)
    expect(blocks0.length).toBe(2)
    const snaps0 = blocks0.map((b) => snapshot(before, b))
    // 頭の塊(動かした元のクリップ)にも、声・ワイプ・発言テロップがある
    const head = snaps0[0]
    expect(head.some((x) => x.startsWith('v:'))).toBe(true)
    expect(head.some((x) => x.startsWith('w:face'))).toBe(true)
    expect(head.some((x) => x.startsWith('t|'))).toBe(true)
    // どちらかの塊に SE か BGM がある
    expect(snaps0.flat().some((x) => x.startsWith('se|') || x.startsWith('bgm|'))).toBe(true)
    // 長さの目標を変えて作り直す(ロックの外の場面の残し方が変わり、元の所の塊の位置がずれる)
    usePipelineStore.getState().setTargetMinutes(2.5)
    await usePipelineStore.getState().rebuildRoughCut()
    const now = project()
    const pairs = matchLockBlocks(before.clips, now.clips, info, seg)
    expect(pairs.length).toBe(2)
    expect(timelineBlocksOf(now.clips, info, seg).length).toBe(2)
    for (const { prev, now: w } of pairs) {
      const k = blocks0.findIndex((b) => b.start === prev.start)
      expect(snapshot(now, w)).toEqual(snaps0[k])
    }
    // 頭の塊は頭のまま。元の所の塊はずれた(ずれても中身は同じ)
    const headPair = pairs.find((x) => x.prev.start === blocks0[0].start)!
    expect(headPair.now.start).toBeCloseTo(0, 6)
    const mainPair = pairs.find((x) => x.prev.start === blocks0[1].start)!
    expect(Math.abs(mainPair.now.start - mainPair.prev.start)).toBeGreaterThan(0.5)
  })

  it('画面のロックの帯は、塊ごとに1本ずつ、塊の所に出る(作り直した後も)', async () => {
    const { seg, before } = await splitLock()
    const info = before.multicam!
    const bands = (): { start: number; end: number }[] =>
      lockRangesOf(project()).map((x) => ({ start: x.range.start, end: x.range.end }))
    const blocks = (): { start: number; end: number }[] =>
      timelineBlocksOf(project().clips, info, seg).map((b) => ({ start: b.start, end: b.end }))
    expect(bands().length).toBe(2)
    expect(bands()).toEqual(blocks())
    // 帯の印はみな違う
    const keys = lockRangesOf(project()).map((x) => x.key)
    expect(new Set(keys).size).toBe(keys.length)
    usePipelineStore.getState().setTargetMinutes(2.5)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(bands().length).toBe(2)
    expect(bands()).toEqual(blocks())
    // 続くロックなら1本
    useProjectStore.getState().removeClip(project().clips[0].id)
    expect(bands().length).toBe(1)
  })

  it('zFence の場面: ロックの頭が、前の枚を次の枚の頭までつないだ所に掛かっても、ちらつく隙間が残らない', async () => {
    await episode2()
    const p0 = project()
    const info = p0.multicam!
    // 1本のクリップの中の発言を、0.2 秒の間を空けた2つに分ける(前は 10 文字・1 秒より長いので、読む長さでは
    // 延ばさないが、0.2 秒の間は次の枚の頭までつなぐ)
    const covs = p0.clips.map((c) => coverageOfClips([c], info)[0])
    const u = (p0.transcript ?? []).find((x) => {
      const f = info.files.find((g) => g.assetId === x.assetId)
      if (!f) return false
      const a = toCommon(f, x.sourceStart)
      const b = toCommon(f, x.sourceEnd)
      return b - a >= 3 && covs.some((c) => c && c.start <= a && c.end >= b + 0.3)
    })!
    expect(u).toBeTruthy()
    const mid = (u.sourceStart + u.sourceEnd) / 2
    const first = {
      ...u,
      id: `${u.id}-a`,
      sourceEnd: mid - 0.1,
      text: 'あいうえおかきくけこ',
      words: []
    }
    const second = { ...u, id: `${u.id}-b`, sourceStart: mid + 0.1, text: 'さしすせそ', words: [] }
    useProjectStore.setState({
      project: {
        ...p0,
        transcript: (p0.transcript ?? []).flatMap((x) => (x.id === u.id ? [first, second] : [x]))
      }
    })
    await usePipelineStore.getState().rebuildRoughCut()
    const tel = (q: Project, id: string): { startTime: number; endTime: number } =>
      q.textOverlays.find((o) => o.utteranceId === id)!
    // 作り直すと、前の枚は次の枚の頭までつながる
    const p1 = project()
    expect(tel(p1, first.id).endTime).toBeCloseTo(tel(p1, second.id).startTime, 6)
    // ロックの頭を、つないだ所の中(前の枚の声の終わりの 0.05 秒後・次の枚の 0.15 秒前)に。終わりは次のクリップの頭から 1 秒。次のクリップを
    // 頭へ動かして、ロックの窓が続かないようにする(元の所の塊と、頭へ動かした塊)
    const f = info.files.find((g) => g.assetId === u.assetId)!
    const hi = p1.clips.findIndex((c) => {
      const cv = coverageOfClips([c], info)[0]
      return cv && cv.start <= toCommon(f, mid) && cv.end >= toCommon(f, u.sourceEnd)
    })
    const next = p1.clips[hi + 1]
    expect(next).toBeTruthy()
    const nextCov = coverageOfClips([next], info)[0]
    const lock = { start: toCommon(f, mid - 0.05), end: nextCov.start + 1 }
    useProjectStore.getState().moveClipToIndex(next.id, 0)
    useProjectStore.getState().addAutoEditLock(lock)
    expect(timelineBlocksOf(project().clips, info, lock).length).toBe(2)
    await usePipelineStore.getState().rebuildRoughCut()
    // 元の所では、前の枚はロックの頭を越えて次の枚の頭までつながったまま(0.2 秒の隙間で点滅しない)
    const p2 = project()
    const main = timelineBlocksOf(p2.clips, info, lock).find((x) => x.start > 0.5)!
    expect(main).toBeTruthy()
    const b = p2.textOverlays.find(
      (o) => o.utteranceId === second.id && Math.abs(o.startTime - (main.start + 0.15)) < 0.02
    )!
    expect(b).toBeTruthy()
    const a = p2.textOverlays
      .filter((o) => o.utteranceId === first.id && o.startTime < b.startTime)
      .sort((x, y) => y.endTime - x.endTime)[0]
    expect(Math.abs(b.startTime - a.endTime)).toBeLessThan(0.02)
    // 時間の飛ばない所で、発言テロップの間に 0.3 秒以下の隙間(点滅に見える)が無い
    const cuts = mainHardCuts(p2)
    const list = p2.textOverlays
      .filter((o) => o.utteranceId)
      .sort((x, y) => x.startTime - y.startTime)
    for (let j = 1; j < list.length; j++) {
      const gap = list[j].startTime - list[j - 1].endTime
      if (gap <= 0.02 || gap > 0.3) continue
      const atCut = cuts.some(
        (c) => c >= list[j - 1].endTime - 1e-6 && c <= list[j].startTime + 1e-6
      )
      expect(atCut, `${list[j - 1].endTime}-${list[j].startTime}`).toBe(true)
    }
  })
})

describe('離れた塊の目印が作り直しで消えたとき(差し込みの画と同じ置き方)', () => {
  /**
   * 前の本編: Y(90-95) X(100-110) 差し込みの画 複製(150-155) A(140-160) B(170-180)。ロックは 150-155。
   * 作り直した本編は X を落とし、A を別のカメラにする(Y を残すかは `keepY`)
   */
  async function run(keepY: boolean): Promise<string[]> {
    await episode2()
    const base = project()
    const info = base.multicam!
    const cam = info.files.find((f) => f.sourceId === 'cam')!.assetId
    const camb = info.files.find((f) => f.sourceId === 'camb')!.assetId
    const clip = (id: string, assetId: string, a: number, b: number): Clip => ({
      id,
      assetId,
      inPoint: a,
      outPoint: b,
      speed: 1,
      audioDetached: true
    })
    const still = {
      id: 'still',
      filePath: '/r/title.png',
      fileName: 'title.png',
      duration: 3,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: false,
      hasVideo: true
    }
    useProjectStore.setState({
      project: {
        ...base,
        assets: [...base.assets, still],
        clips: [
          clip('Y', cam, 90, 95),
          clip('X', cam, 100, 110),
          clip('E', 'still', 0, 3),
          clip('COPY', cam, 150, 155),
          clip('A', cam, 140, 160),
          clip('B', cam, 170, 180)
        ],
        autoEditLocks: [{ id: 'L', start: 150, end: 155 }]
      }
    })
    const main = [
      ...(keepY ? [{ assetId: cam, inPoint: 90, outPoint: 95, speed: 1 }] : []),
      { assetId: camb, inPoint: 140, outPoint: 160, speed: 1 },
      { assetId: cam, inPoint: 170, outPoint: 180, speed: 1 }
    ]
    let at = 0
    const spans = main.map((m) => {
      const s = { timeline: at, start: m.inPoint, end: m.outPoint }
      at += m.outPoint - m.inPoint
      return s
    })
    const cut: RoughCut = { main, audio: [], duration: at, spans }
    useProjectStore.getState().applyRoughCut(cut, [], undefined, {
      windows: [{ start: 150, end: 155 }]
    })
    const p = project()
    return p.clips.map((c) => {
      if (c.assetId === 'still') return 'E'
      const f = info.files.find((g) => g.assetId === c.assetId)!
      return `${f.sourceId}:${c.inPoint}-${c.outPoint}`
    })
  }

  it('目印(X の終わり)より前に始まる最後のクリップ(Y)の後ろへ、差し込みの画と同じ所に、前の順のまま置く', async () => {
    expect(await run(true)).toEqual([
      'cam:90-95',
      'E',
      'cam:150-155',
      'camb:140-150',
      'cam:150-155',
      'camb:155-160',
      'cam:170-180'
    ])
  })

  it('目印より前に始まるクリップが無ければ頭へ(差し込みの画と同じ)', async () => {
    expect(await run(false)).toEqual([
      'E',
      'cam:150-155',
      'camb:140-150',
      'cam:150-155',
      'camb:155-160',
      'cam:170-180'
    ])
  })
})

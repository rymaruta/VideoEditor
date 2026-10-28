/* eslint-disable @typescript-eslint/explicit-function-return-type -- 監査で書いた再現の試験をそのまま取り込んだもの */
import { usePipelineStore } from '@renderer/store/pipelineStore'
import { useProjectStore } from '@renderer/store/projectStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { flush, stubApi } from '../helpers/episodeHarness'
import {
  coverageOfClips,
  subtractRanges,
  unionRanges,
  updateOverrides,
  type CutOverrides
} from '@shared/roughCut/overrides'
import type { Project } from '@shared/types'
import { clipTimes, timelineBlocksOf } from '@shared/roughCut/range'
import { toCommon } from '@shared/sync/multicam'

export const KIT = {
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

export async function episode2(twoCams = true): Promise<void> {
  stubApi({
    showKitScan: async () => KIT,
    syncRun: async () => ({
      placements: [
        { id: '/r/a.mp4', start: 0, method: 'reference', rate: 1 },
        ...(twoCams ? [{ id: '/r/b.mp4', start: 0, method: 'audio', rate: 1 }] : [])
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
    episodeKind: 'location',
    showKitFolder: '/kit'
  } as never)
  useProjectStore.getState().newProject('第1回')
  await flush()
  const file = (p: string) => ({
    path: p,
    relativePath: p.slice(3),
    duration: 240,
    hasVideo: true,
    hasAudio: true
  })
  usePipelineStore.setState({
    running: false,
    root: '/r',
    scanTracks: false,
    scan: { root: '/r', sources: [], skipped: [], stats: {} },
    sources: [
      { id: 'cam', name: 'カメラA', kind: 'camera', basis: '', files: [file('/r/a.mp4')] },
      ...(twoCams
        ? [{ id: 'camb', name: 'カメラB', kind: 'camera', basis: '', files: [file('/r/b.mp4')] }]
        : [])
    ]
  } as never)
  await usePipelineStore.getState().runPipeline()
  usePipelineStore.getState().setTargetMinutes(1.5)
  await usePipelineStore.getState().rebuildRoughCut()
}

export const project = (): Project => useProjectStore.getState().project

/** 今の企画から読み取る人の手直し */
export function memory(p: Project = project()): CutOverrides {
  // 組んだ本編の記録が無い(仮編集を入れる前まで取り消した)ときは、作り直しと同じく覚えている手直しだけ
  // (今の本編を全部「人が足した」とは読まない。pipelineStore.buildAndApply と同じ)
  if (!p.roughCutAuto) return p.cutOverrides ?? { removed: [], added: [], angles: [] }
  return updateOverrides(
    p.cutOverrides,
    p.roughCutAuto ?? [],
    coverageOfClips(p.clips, p.multicam!)
  )
}
export const cov = (p: Project = project()) => coverageOfClips(p.clips, p.multicam!)
export const len = (rs: { start: number; end: number }[]): number =>
  unionRanges(rs).reduce((t, r) => t + r.end - r.start, 0)
export const minus = subtractRanges
export function inter(a: { start: number; end: number }[], b: { start: number; end: number }[]) {
  return subtractRanges(unionRanges(a), subtractRanges(unionRanges(a), unionRanges(b)))
}

/**
 * ロックした塊の、タイムラインの順の中身の並び(どのロックか・共通の時刻・カメラ)。すべてのロックの塊を
 * タイムラインの順に並べ、同じロックの続いた同じカメラの所はまとめる(`matchLockBlocks` を使わない確かめ)
 */
export function lockOrder(p: Project = project()): string {
  const info = p.multicam
  if (!info) return ''
  const items = (p.autoEditLocks ?? []).flatMap((l, li) =>
    timelineBlocksOf(p.clips, info, l).map((b) => ({ li, b }))
  )
  items.sort((x, y) => x.b.start - y.b.start)
  const out: { li: number; start: number; end: number; cameraId: string }[] = []
  for (const { li, b } of items)
    for (const s of b.segs) {
      const last = out[out.length - 1]
      if (
        last &&
        last.li === li &&
        last.cameraId === s.cameraId &&
        Math.abs(last.end - s.start) < 1e-3
      )
        last.end = s.end
      else out.push({ li, start: s.start, end: s.end, cameraId: s.cameraId })
    }
  return out
    .map((s) => `${s.li}:${s.cameraId}[${s.start.toFixed(2)},${s.end.toFixed(2)}]`)
    .join(' ')
}

interface LockBlockSide {
  /** ロック(作り直しで同じロックの塊はつながることがあるので、ロックで見分ける) */
  lockId: string
  text: string
  badBefore: boolean
  badAfter: boolean
  /** 前後の少なくとも片側が順に並ぶ(両側とも自由な所が無いときも) */
  inPlace: boolean
  first: number
  last: number
}

/** ロックした塊ごとの、前後の自由な所(どのロックの塊にも入っていない収録素材のクリップの所)との並び */
function lockBlockSides(p: Project): LockBlockSide[] {
  const info = p.multicam
  if (!info) return []
  const all = (p.autoEditLocks ?? [])
    .flatMap((l) => timelineBlocksOf(p.clips, info, l).map((b) => ({ l, b })))
    .sort((x, y) => x.b.start - y.b.start)
  const times = clipTimes(p.clips)
  const free: { ts: number; te: number; cs: number; ce: number }[] = []
  p.clips.forEach((c, i) => {
    const f = info.files.find((x) => x.assetId === c.assetId)
    if (!f) return
    const sp = c.speed || 1
    const at = (t: number): number => toCommon(f, c.inPoint + (t - times[i].start) * sp)
    for (const r of subtractRanges(
      [times[i]],
      all.map((x) => x.b)
    ))
      free.push({ ts: r.start, te: r.end, cs: at(r.start), ce: at(r.end) })
  })
  free.sort((a, b) => a.ts - b.ts)
  return all.map(({ l, b }) => {
    const first = b.segs[0].start
    const last = b.segs[b.segs.length - 1].end
    const before = [...free].reverse().find((x) => x.te <= b.start + 1e-6)
    const after = free.find((x) => x.ts >= b.end - 1e-6)
    const badBefore = before !== undefined && before.ce > first + 0.05
    const badAfter = after !== undefined && after.cs < last - 0.05
    const okBefore = before !== undefined && !badBefore
    const okAfter = after !== undefined && !badAfter
    return {
      lockId: l.id,
      text: `[${first.toFixed(2)},${last.toFixed(2)}] before=${before ? before.ce.toFixed(2) : '-'}${badBefore ? '!' : ''} after=${after ? after.cs.toFixed(2) : '-'}${badAfter ? '!' : ''}`,
      badBefore,
      badAfter,
      inPlace: okBefore || okAfter || (!before && !after),
      first,
      last
    }
  })
}

/**
 * ロックした塊の、前後の自由な所との食い違いの数。塊の直前の自由な所の終わりが塊の頭より後ろ、直後の
 * 自由な所の頭が塊の終わりより前なら、その側は食い違う(前後に自由な所が無い側は数えない)。作り直しで
 * 食い違う側が増えたら、ロックした塊が並べ替えたクリップに付いて動いた(`lockOrder` では見えない)。
 * `inPlace` は元の所の塊を持つロック(作り直しで元の所を失えば、塊が動いた。食い違いの数が変わらなくても)
 */
export function lockNeighborMismatches(p: Project = project()): {
  count: number
  inPlace: Set<string>
  detail: string
} {
  const sides = lockBlockSides(p)
  const count = sides.reduce((n, x) => n + Number(x.badBefore) + Number(x.badAfter), 0)
  // 元の所の塊(前後の少なくとも片側と順に並ぶ)を持つロック
  const inPlace = new Set(sides.filter((x) => x.inPlace).map((x) => x.lockId))
  return {
    count,
    inPlace,
    detail: lockBlockSides(p)
      .map((x) => x.text)
      .join(' ')
  }
}

/**
 * どちらも元の所(前後の少なくとも片側と順に並ぶ)なのに、タイムラインで共通の時刻と逆の順に並んでいる
 * 塊の組の数(人がロックを含むクリップごと並べ替えた)。作り直した本編はロックの外を共通の時刻の順に
 * 並べるので、ロックした塊どうしの順を保つと、組ごとにどちらかの前後が1つ食い違う。作り直しで増えてよい
 * 食い違いの数の上限に使う(ロックを丸ごと確かめから外さない)
 */
export function reversedPairs(p: Project = project()): number {
  const sides = lockBlockSides(p)
  let n = 0
  for (let i = 0; i < sides.length; i++)
    for (let j = i + 1; j < sides.length; j++) {
      const a = sides[i]
      const b = sides[j]
      if (a.inPlace && b.inPlace && a.last > b.first + 0.05) n++
    }
  return n
}

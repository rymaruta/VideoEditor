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

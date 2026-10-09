import { describe, expect, it } from 'vitest'
import { useProjectStore } from '@renderer/store/projectStore'
import type { Project } from '@shared/types'

const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()
const MICS = [1, 2, 3, 4, 5, 6]

/** 60分・2,000クリップ・ピンマイク6本の仮編集 */
function setup(n: number): void {
  const files = [
    { assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 4 * n + 10 },
    ...MICS.map((k) => ({
      assetId: `mic${k}`,
      sourceId: `M${k}`,
      start: 0,
      rate: 1,
      duration: 4 * n + 10
    }))
  ]
  S.setState({
    project: {
      id: 'p',
      name: 'perf',
      aspectRatio: '16:9',
      multicam: {
        anchorSourceId: 'A',
        sources: [
          { id: 'A', name: 'A', kind: 'camera' },
          ...MICS.map((k) => ({ id: `M${k}`, name: `M${k}`, kind: 'mic' }))
        ],
        files
      },
      assets: files.map((f) => ({
        id: f.assetId,
        filePath: `/rec/${f.assetId}.mp4`,
        fileName: `${f.assetId}.mp4`,
        duration: f.duration + 1,
        width: f.assetId === 'camA' ? 1920 : 0,
        height: f.assetId === 'camA' ? 1080 : 0,
        fps: f.assetId === 'camA' ? 30 : 0,
        hasAudio: true,
        hasVideo: f.assetId === 'camA'
      })),
      clips: [],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: [],
      beatGrid: null
    } as unknown as Project,
    past: [],
    future: [],
    selectedClipId: null,
    multiSelectedClipIds: [],
    selectedOverlayId: null,
    isDirty: false
  })
  const ranges = Array.from({ length: n }, (_, i) => [i * 4, i * 4 + 1.8] as [number, number])
  let t = 0
  const pieces = ranges.map(([a, b]) => {
    const p = { startTime: t, inPoint: a, outPoint: b, speed: 1 }
    t += b - a
    return p
  })
  st().applyRoughCut(
    {
      main: ranges.map(([a, b]) => ({ assetId: 'camA', inPoint: a, outPoint: b, speed: 1 })),
      audio: MICS.map((k) => ({
        name: `M${k}`,
        sourceId: `M${k}`,
        volume: 1,
        clips: pieces.map((p) => ({ ...p, assetId: `mic${k}` }))
      })),
      duration: t,
      spans: []
    } as never,
    []
  )
}

describe('速さを変えたクリップの多い本編でも、編集の追従が重くならない', () => {
  it('2,000クリップを全部速くした本編で、1本を伸ばす追従が速い', () => {
    setup(2000)
    const ids = st().project.clips.map((c) => c.id)
    st().updateClipsSpeed(ids, 1.1)
    const c = st().project.clips[500]
    const t0 = performance.now()
    st().updateClipTrim(ids[500], c.inPoint, c.outPoint + 0.5)
    // 速くしたクリップごとに対応の索引を作り直していたときは 280ms(今は 20ms ほど)
    expect(performance.now() - t0).toBeLessThan(150)
  }, 120000)
})

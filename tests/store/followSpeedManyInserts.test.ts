import { describe, expect, it } from 'vitest'
import { useProjectStore } from '@renderer/store/projectStore'
import type { Project } from '@shared/types'

// 差し込みの素材ごとに仮の時刻の置き場が増える(モジュールの状態)ので、ほかのテストと分けたファイルにする
const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()
const asset = (id: string, duration: number, hasVideo = true): Project['assets'][number] => ({
  id,
  filePath: `/rec/${id}.mp4`,
  fileName: `${id}.mp4`,
  duration,
  width: hasVideo ? 1920 : 0,
  height: hasVideo ? 1080 : 0,
  fps: hasVideo ? 30 : 0,
  hasAudio: true,
  hasVideo
})

describe('差し込みの素材が多い本編でも、速くしたクリップを伸ばした所の声が正しい', () => {
  it('B ロールを70本差し込んだあと、速くした2本目の頭を伸ばすと、その頭から声が鳴る', () => {
    const ranges: [number, number][] = [
      [20.0087, 44.0039],
      [60, 70]
    ]
    S.setState({
      project: {
        id: 'p',
        name: 'many',
        aspectRatio: '16:9',
        multicam: {
          anchorSourceId: 'A',
          sources: [
            { id: 'A', name: 'カメラA', kind: 'camera' },
            { id: 'M', name: '出演者A', kind: 'mic' }
          ],
          files: [
            { assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 },
            { assetId: 'micM', sourceId: 'M', start: 0, rate: 1, duration: 100 }
          ]
        },
        assets: [
          asset('camA', 101),
          asset('micM', 101, false),
          ...Array.from({ length: 70 }, (_, i) => asset(`broll${i}`, 5))
        ],
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
    let t = 0
    const voice = ranges.map(([a, b]) => {
      const c = { assetId: 'micM', startTime: t, inPoint: a, outPoint: b, speed: 1 }
      t += b - a
      return c
    })
    st().applyRoughCut(
      {
        main: ranges.map(([a, b]) => ({ assetId: 'camA', inPoint: a, outPoint: b, speed: 1 })),
        audio: [{ name: '出演者A', sourceId: 'M', volume: 1, clips: voice }],
        duration: t,
        spans: []
      },
      []
    )
    for (let i = 0; i < 70; i++) st().addClipToTimeline(`broll${i}`)
    const ids = st()
      .project.clips.slice(0, 2)
      .map((c) => c.id)
    st().updateClipsSpeed(ids, 1.5)
    st().updateClipTrim(ids[1], 55, 70)
    const p = st().project
    const head = (p.clips[0].outPoint - p.clips[0].inPoint) / (p.clips[0].speed || 1)
    const v = p.audioTracks
      .find((x) => x.multicamSourceId === 'M')!
      .clips.find((c) => Math.abs(c.startTime - head) < 1e-3)!
    // 仮の時刻の誤差で前のクリップの続き(素材の 44 秒)を鳴らしていた
    expect(v.inPoint).toBeCloseTo(55, 3)
  })
})

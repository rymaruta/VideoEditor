import { describe, expect, it } from 'vitest'
import { useProjectStore } from '@renderer/store/projectStore'
import type { Project } from '@shared/types'

const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()

const asset = (id: string): Project['assets'][number] => ({
  id,
  filePath: `/rec/${id}.mp4`,
  fileName: `${id}.mp4`,
  duration: 20,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  hasVideo: true
})

const overlay = (
  id: string,
  startTime: number,
  linkOffset: number
): Project['textOverlays'][number] =>
  ({
    id,
    text: id,
    startTime,
    endTime: startTime + 0.5,
    style: {},
    source: 'manual',
    linkedClipId: 'c2',
    linkOffset
  }) as Project['textOverlays'][number]

function reset(): void {
  S.setState({
    project: {
      id: 'p',
      name: 'r13',
      aspectRatio: '16:9',
      assets: [asset('A'), asset('B')],
      clips: [
        { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 10, speed: 1 },
        { id: 'c2', assetId: 'B', inPoint: 0, outPoint: 10, speed: 1 }
      ],
      audioTracks: [],
      videoOverlayTracks: [],
      // c2 の頭より 0.5 秒前・終わりより 0.5 秒後ろにずらして置いたテロップ
      textOverlays: [overlay('before', 9.5, -0.5), overlay('after', 20.5, 10.5)],
      beatGrid: null
    } as unknown as Project,
    past: [],
    future: [],
    selectedClipId: null,
    multiSelectedClipIds: [],
    selectedOverlayId: null,
    isDirty: false
  })
}

const starts = (): number[] => st().project.textOverlays.map((o) => o.startTime)

describe('第13回: 編集モデルの見直し', () => {
  it('クリップの外にずらしたテロップは、トリムでも範囲の置き換えでも同じ位置に残る', () => {
    reset()
    st().updateClipTrim('c2', 3, 8)
    const byTrim = starts()
    reset()
    const c2 = st().project.clips[1]
    st().replaceClipRange('c2', [{ ...c2, id: 'c2b', inPoint: 3, outPoint: 8 }])
    const byReplace = starts()
    // 頭より前は頭から、終わりより後ろは終わりからの距離を保つ
    expect(byReplace[0]).toBeCloseTo(9.5, 9)
    expect(byReplace[1]).toBeCloseTo(15.5, 9)
    byTrim.forEach((s, i) => expect(s).toBeCloseTo(byReplace[i], 9))
  })

  it('クリップの外にずらしたテロップの位置は、ドラッグの刻み(マウスの速さ)で変わらない', () => {
    const run = (steps: [number, number][]): number[] => {
      reset()
      const p = st().project
      S.setState({
        project: {
          ...p,
          clips: [p.clips[0], { ...p.clips[1], inPoint: 5, outPoint: 10 }],
          // 頭より1秒前(素材の4秒)・終わりより1秒後ろ(素材の11秒)
          textOverlays: [overlay('before', 9, -1), overlay('after', 16, 6)]
        }
      })
      // 前の実行のドラッグと続けてまとめないよう、普通の編集を1つはさむ
      st().updateClipSpeed('c1', 2)
      for (const [a, b] of steps) st().updateClipTrim('c2', a, b)
      return st().project.textOverlays.map((o) => o.linkOffset ?? NaN)
    }
    const oneStep = run([[3, 13]])
    const manySteps = run([
      [4.6, 10.5],
      [4.2, 11],
      [3.8, 11.5],
      [3.4, 12],
      [3, 12.5],
      [3, 13]
    ])
    manySteps.forEach((v, i) => expect(v).toBeCloseTo(oneStep[i], 9))
    // 行って戻れば元の位置
    expect(
      run([
        [3, 13],
        [5, 10]
      ])
    ).toEqual([-1, 6])
  })

  it('外したプロキシは、取り消し・やり直しで戻ってこない', () => {
    reset()
    S.setState({
      project: {
        ...st().project,
        assets: st().project.assets.map((a) =>
          a.id === 'A' ? { ...a, proxyPath: '/gone/A.mp4' } : a
        )
      }
    })
    st().updateClipSpeed('c1', 2)
    st().setAssetProxyPath('A', undefined)
    st().undo()
    expect(st().project.assets.find((a) => a.id === 'A')!.proxyPath).toBeUndefined()
    st().redo()
    expect(st().project.assets.find((a) => a.id === 'A')!.proxyPath).toBeUndefined()
  })
})

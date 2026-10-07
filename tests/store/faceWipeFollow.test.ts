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
import { useProjectStore } from '@renderer/store/projectStore'

/** 本編のクリップを伸ばしたら、顔カメラのワイプも新しく見えた所に足す(声のトラックと同じ) */
describe('顔カメラのワイプは本編の手直しに付いてくる', () => {
  it('伸ばして新しく見えた所に、マイクと同じく顔カメラの絵を足す', () => {
    const P = useProjectStore
    P.getState().newProject()
    const asset = (id: string, video: boolean): Record<string, unknown> => ({
      id,
      filePath: `/r/${id}`,
      fileName: id,
      duration: 100,
      width: video ? 1920 : 0,
      height: video ? 1080 : 0,
      hasAudio: true,
      hasVideo: video
    })
    P.setState({
      project: {
        ...P.getState().project,
        assets: [asset('A', true), asset('F', true), asset('M', false)] as never,
        multicam: {
          anchorSourceId: 'a',
          sources: [
            { id: 'a', name: '画面', kind: 'camera', cameraRole: 'screen' },
            { id: 'f', name: '顔', kind: 'camera', cameraRole: 'face' },
            { id: 'm', name: '声', kind: 'mic' }
          ],
          files: [
            { assetId: 'A', sourceId: 'a', start: 0, rate: 1, duration: 100 },
            { assetId: 'F', sourceId: 'f', start: 0, rate: 1, duration: 100 },
            { assetId: 'M', sourceId: 'm', start: 0, rate: 1, duration: 100 }
          ]
        }
      }
    })
    const piece = (
      assetId: string,
      startTime: number,
      inPoint: number,
      outPoint: number
    ): Record<string, unknown> => ({
      assetId,
      startTime,
      inPoint,
      outPoint,
      speed: 1
    })
    P.getState().applyRoughCut(
      {
        main: [
          { assetId: 'A', inPoint: 0, outPoint: 10, speed: 1 },
          { assetId: 'A', inPoint: 20, outPoint: 30, speed: 1 }
        ],
        audio: [
          {
            sourceId: 'm',
            name: '声',
            volume: 1,
            clips: [piece('M', 0, 0, 10), piece('M', 10, 20, 30)]
          }
        ],
        overlays: [
          {
            sourceId: 'f',
            name: '顔',
            clips: [
              { assetId: 'F', startTime: 0, inPoint: 0, outPoint: 10 },
              { assetId: 'F', startTime: 10, inPoint: 20, outPoint: 30 }
            ]
          }
        ],
        duration: 20,
        spans: []
      } as never,
      []
    )
    const first = P.getState().project.clips[0]
    P.getState().updateClipTrim(first.id, 0, 15)
    const p = P.getState().project
    const lay = (clips: { startTime: number; inPoint: number; outPoint: number }[]): number[][] =>
      clips.map((c) => [c.startTime, c.inPoint, c.outPoint])
    const mic = p.audioTracks.find((t) => t.multicamSourceId === 'm')!
    const face = p.videoOverlayTracks.find((t) => t.multicamSourceId === 'f')!
    expect(lay(face.clips)).toEqual(lay(mic.clips))
    expect(lay(face.clips)).toContainEqual([10, 10, 15])
  })
})

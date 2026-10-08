import { describe, expect, it } from 'vitest'
import { useQcStore } from '@renderer/store/qcStore'
import type { QcMeasurement } from '@shared/qc/media'
import type { Project } from '@shared/types'

const measurement = (black: { start: number; end: number }[] = []): QcMeasurement => ({
  black,
  freeze: [],
  silence: [],
  loudness: null,
  duration: 7
})

/** main の確認: 1つずつしか測らない。止めると測っている確認は QC_CANCELED で終わる */
function stubApi(results: Record<string, QcMeasurement>): { resolve: (path: string) => void } {
  const pending = new Map<string, { ok: (m: QcMeasurement) => void; ng: (e: Error) => void }>()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      onQcProgress: () => () => {},
      qcCancel: async () => {
        for (const [path, p] of pending) {
          pending.delete(path)
          p.ng(new Error('QC_CANCELED'))
        }
      },
      qcMeasure: (path: string) =>
        new Promise<QcMeasurement>((ok, ng) => {
          if (pending.size > 0) return ng(new Error('自動確認はすでに実行中です'))
          pending.set(path, { ok, ng })
        })
    }
  }
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ getContext: () => null })
  }
  return {
    resolve: (path) => {
      const p = pending.get(path)
      pending.delete(path)
      p?.ok(results[path])
    }
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const project = {
  id: 'p',
  name: 'qc',
  aspectRatio: '16:9',
  assets: [
    {
      id: 'A',
      filePath: '/a.mp4',
      fileName: 'a.mp4',
      duration: 10,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      hasVideo: true
    }
  ],
  clips: [
    { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1 },
    {
      id: 'c2',
      assetId: 'A',
      inPoint: 0,
      outPoint: 4,
      speed: 1,
      transitionIn: { type: 'crossfade', duration: 1 }
    }
  ],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: [],
  beatGrid: null
} as unknown as Project

describe('書き出し後の自動確認', () => {
  it('前の確認の途中で次の書き出しが終わったら、前を止めて次のファイルを確認する', async () => {
    const api = stubApi({ '/a.mp4': measurement(), '/b.mp4': measurement() })
    useQcStore.setState({ report: null })
    const first = useQcStore.getState().run('/a.mp4', 'off', project)
    await tick()
    const second = useQcStore.getState().run('/b.mp4', 'off', project)
    await tick()
    await tick()
    api.resolve('/b.mp4')
    await Promise.all([first, second])
    const report = useQcStore.getState().report
    expect(report?.path).toBe('/b.mp4')
    expect(report?.state).toBe('done')
  })

  it('黒味などの時刻は、繋ぎのぶん短いファイルの秒ではなく、タイムラインの秒で出す', async () => {
    const api = stubApi({ '/a.mp4': measurement([{ start: 3.9, end: 7 }]) })
    useQcStore.setState({ report: null })
    const done = useQcStore.getState().run('/a.mp4', 'off', project)
    await tick()
    api.resolve('/a.mp4')
    await done
    const black = useQcStore.getState().report?.issues.find((i) => i.kind === 'black')
    expect(black?.start).toBeCloseTo(4.9, 6)
    expect(black?.end).toBeCloseTo(8, 6)
  })
})

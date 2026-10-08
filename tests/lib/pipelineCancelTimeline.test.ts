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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 素材を読む(probeMedia)所で待たせる。`release` で返す */
function stubApi(): { release: () => void; notified: string[] } {
  let release = (): void => {}
  const notified: string[] = []
  const probe = (): Promise<unknown> =>
    new Promise((resolve) => {
      release = () =>
        resolve({
          duration: 30,
          width: 1920,
          height: 1080,
          fps: 30,
          hasAudio: true,
          hasVideo: true,
          videoCodec: 'h264',
          audioCodec: 'aac',
          needsPreviewProxy: false
        })
    })
  const known: Record<string, unknown> = {
    syncRun: async () => ({
      placements: [{ id: '/r/a.mp4', start: 0, method: 'reference', rate: 1 }],
      issues: [],
      pairs: [],
      elapsedMs: 1
    }),
    onSyncProgress: () => () => {},
    probeMedia: probe,
    generateThumbnail: async () => undefined,
    notifyDone: (title: string) => void notified.push(title),
    setBusyState: () => {}
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    dispatchEvent: () => true,
    api: new Proxy(known, {
      get: (t, k: string) => (k in t ? t[k] : () => Promise.resolve())
    })
  }
  return { release: () => release(), notified }
}

function prepare(): void {
  useProjectStore.getState().newProject()
  usePipelineStore.setState({
    running: false,
    root: '/r',
    scanTracks: false,
    scan: { root: '/r', sources: [], skipped: [], stats: {} },
    sources: [
      {
        id: 'cam',
        name: 'カメラA',
        kind: 'camera',
        basis: '',
        files: [
          {
            path: '/r/a.mp4',
            relativePath: 'a.mp4',
            duration: 30,
            hasVideo: true,
            hasAudio: true
          }
        ]
      }
    ]
  } as never)
}

describe('自動編集の「タイムラインに並べる」の途中', () => {
  it('別のプロジェクトを開いたら、そちらに前の回の素材を並べない', async () => {
    const api = stubApi()
    prepare()
    const run = usePipelineStore.getState().runPipeline()
    await flush()
    await flush()
    useProjectStore.getState().newProject()
    usePipelineStore.getState().cancel()
    api.release()
    await run
    expect(useProjectStore.getState().project.clips).toHaveLength(0)
  })

  it('中止したら「終わりました」と知らせない', async () => {
    const api = stubApi()
    prepare()
    const run = usePipelineStore.getState().runPipeline()
    await flush()
    await flush()
    usePipelineStore.getState().cancel()
    api.release()
    await run
    await flush()
    expect(api.notified).not.toContain('自動編集が終わりました')
  })

  it('別のプロジェクトを開いたら、そのプロジェクトの工程に前の実行の「中止しました」を書かない', async () => {
    const api = stubApi()
    prepare()
    usePipelineStore.setState({
      steps: {
        ...usePipelineStore.getState().steps,
        ingest: { state: 'done', percent: 100 }
      }
    } as never)
    const run = usePipelineStore.getState().runPipeline()
    await flush()
    await flush()
    useProjectStore.getState().newProject()
    usePipelineStore.getState().cancel()
    usePipelineStore.getState().resetResults()
    api.release()
    await run
    const steps = usePipelineStore.getState().steps
    expect(Object.values(steps).some((s) => s.note === '中止しました')).toBe(false)
  })
})

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
import { useSettingsStore } from '@renderer/store/settingsStore'
import type { FootageScan } from '@shared/ingest/classify'

/**
 * 収録フォルダの読み込みと番組の種類(音声トラックを分けるのはゲーム実況だけ)。
 * 読んでいる最中に種類が替わっても、種類に合った読み方の結果だけが残る。読み直しても人の直しは残る
 */

const file = (path: string): Record<string, unknown> => ({
  path,
  relativePath: path,
  duration: 60,
  hasAudio: true,
  hasVideo: true,
  size: 1
})
const scanOf = (tracks: boolean): FootageScan =>
  ({
    root: '/r',
    sources: [
      { id: 'camera:a', name: 'A', kind: 'camera', basis: '', files: [file('/r/a.mp4')] },
      { id: 'camera:b', name: 'B', kind: 'camera', basis: '', files: [file('/r/b.mp4')] },
      ...(tracks
        ? [
            {
              id: 'track:a:1',
              name: '全部入り',
              kind: 'audio',
              basis: '',
              trackRole: 'mix',
              files: [file('/r/a.t1.m4a')]
            }
          ]
        : [])
    ],
    skipped: [],
    stats: {}
  }) as unknown as FootageScan

function installScan(): { calls: boolean[]; resolve: (() => void)[] } {
  const calls: boolean[] = []
  const resolve: (() => void)[] = []
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      onFootageScanProgress: () => () => {},
      footageScan: (_root: string, o?: { tracks?: boolean }) => {
        calls.push(Boolean(o?.tracks))
        return new Promise<FootageScan>((res) =>
          resolve.push(() => res(scanOf(Boolean(o?.tracks))))
        )
      }
    }
  }
  return { calls, resolve }
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('収録フォルダの読み込みと番組の種類', () => {
  it('読んでいる最中にゲーム実況へ替えると、読み終わった所でトラックを分けて読み直す', async () => {
    const api = installScan()
    usePipelineStore.getState().reset()
    useSettingsStore.setState({ episodeKind: 'location' })
    const done = usePipelineStore.getState().scanFolder('/r')
    useSettingsStore.setState({ episodeKind: 'game' })
    api.resolve[0]()
    await flush()
    expect(api.calls).toEqual([false, true])
    api.resolve[1]()
    await done
    const s = usePipelineStore.getState()
    expect(s.scanTracks).toBe(true)
    expect(s.sources.some((x) => x.kind === 'audio')).toBe(true)
    expect(s.steps.ingest.state).toBe('done')
  })

  it('同じフォルダを読み直しても、人が直した役割は残る', async () => {
    const api = installScan()
    usePipelineStore.getState().reset()
    useSettingsStore.setState({ episodeKind: 'game' })
    let p = usePipelineStore.getState().scanFolder('/r')
    api.resolve[0]()
    await p
    usePipelineStore.getState().updateSource('camera:a', { kind: 'skip' })
    usePipelineStore.getState().updateSource('camera:b', { cameraRole: 'face' })
    useSettingsStore.setState({ episodeKind: 'location' })
    p = usePipelineStore.getState().scanFolder('/r')
    api.resolve[1]()
    await p
    const by = new Map(usePipelineStore.getState().sources.map((x) => [x.id, x]))
    expect(by.get('camera:a')?.kind).toBe('skip')
    expect(by.get('camera:b')?.cameraRole).toBe('face')
    expect(by.has('track:a:1')).toBe(false)
  })
})

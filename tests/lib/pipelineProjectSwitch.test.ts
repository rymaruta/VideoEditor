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

/**
 * 自動編集の途中(話者の判定で音量を読んでいる間)に別の企画を開いても、文字起こしの結果を
 * 開いた企画へ書き込まない
 */
describe('自動編集の途中で企画を切り替える', () => {
  it('話者の判定で音量を読む間に新しい企画にしても、その企画に文字起こしを書かない', async () => {
    let releaseEnv: () => void = () => {}
    let envCalled = false
    const env = new Float32Array(3000)
    for (let i = 0; i < 3000; i++) env[i] = Math.floor(i / 100) % 5 < 3 ? 0.2 : 0.0005
    const known: Record<string, unknown> = {
      syncRun: async () => ({
        placements: [{ id: '/r/a.mp4', start: 0, method: 'reference', rate: 1 }],
        issues: [],
        pairs: [],
        elapsedMs: 1
      }),
      onSyncProgress: () => () => {},
      onAsrProgress: () => () => {},
      onDenoiseProgress: () => () => {},
      probeMedia: async () => ({
        duration: 30,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
        hasVideo: true,
        videoCodec: 'h264',
        audioCodec: 'aac',
        needsPreviewProxy: false
      }),
      generateThumbnail: async () => undefined,
      footageEnvelopes: () =>
        new Promise((resolve) => {
          envCalled = true
          releaseEnv = () => resolve([env])
        }),
      // 文字起こしは、始まる前に届いた中止を覚えていない(そのまま答える)
      asrRun: async (jobs: { id: string }[]) => {
        return jobs.map((j) => ({ id: j.id, text: '今日はいい天気ですね', words: [] }))
      },
      setBusyState: () => {},
      notifyDone: () => {}
    }
    ;(globalThis as unknown as { window: unknown }).window = {
      dispatchEvent: () => true,
      api: new Proxy(known, {
        get: (t, k: string) => (k in t ? t[k] : () => Promise.resolve())
      })
    }
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
    const run = usePipelineStore.getState().runPipeline()
    for (let i = 0; i < 50 && !envCalled; i++) await flush()
    expect(envCalled).toBe(true)
    // 利用者が別の企画を開く(新規作成 → 切り替えの知らせ → 中止)
    useProjectStore.getState().newProject('B')
    releaseEnv()
    await run
    const s = useProjectStore.getState()
    expect(s.project.transcript ?? []).toHaveLength(0)
    expect(s.isDirty).toBe(false)
  })
})

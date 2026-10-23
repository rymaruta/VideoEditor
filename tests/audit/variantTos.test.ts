// 実素材(Tears of Steel など1本の動画)で、範囲の作り直しの案を試して閉じる・決めて取り消す(監査 e1507cb)。
// 素材は大きいので置いていない。VARIANT_TOS_FILE に動画のパスを渡したときだけ回す
// (例: VARIANT_TOS_FILE=/path/tos720.mov VARIANT_TOS_CACHE=/tmp/cache npx vitest run tests/audit/variantTos.test.ts)
import { expect, it, vi } from 'vitest'
import { mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const state = vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
  return { cacheDir: '' }
})
vi.mock('electron', () => ({
  app: { getPath: () => state.cacheDir, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { ffmpegPath, probeMedia } from '@main/ffmpegService'
import { cachedEnvelope } from '@main/audioPcm'
import { usePipelineStore } from '@renderer/store/pipelineStore'
import { useProjectStore } from '@renderer/store/projectStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { DEFAULT_RANGED_OPTIONS, mainLength } from '@renderer/lib/rangedAutoEdit'

const FILE = process.env.VARIANT_TOS_FILE ?? ''
const LINES = [
  'あなたは馬鹿よ、トム',
  'セリア、僕たちは夢を追いかけないと',
  '君はロボット工学があるし、僕も宇宙に行きたいだけなんだ',
  'とにかくトム、もう終わりね',
  '本当に怖いな',
  'ここが最後の砦だ、気を抜くな',
  'もう遅いわ、トム',
  'まだ間に合う、一緒に戻ろう'
]

it.skipIf(!FILE)(
  '実素材: 試して閉じると元のまま、決めて取り消すと仮編集のまとめも戻る',
  async () => {
    const userData = process.env.VARIANT_TOS_CACHE ?? join(tmpdir(), 'variant-tos')
    mkdirSync(userData, { recursive: true })
    state.cacheDir = userData
    const st = statSync(FILE)
    const env = await cachedEnvelope(ffmpegPath, join(userData, 'analysis-cache'), {
      path: FILE,
      size: st.size,
      mtimeMs: st.mtimeMs
    })
    const meta = await probeMedia(FILE)
    const known: Record<string, unknown> = {
      syncRun: async () => ({
        placements: [{ id: FILE, start: 0, method: 'reference', rate: 1 }],
        issues: [],
        pairs: [],
        elapsedMs: 1
      }),
      probeMedia: async () => meta,
      generateThumbnail: async () => undefined,
      footageEnvelopes: async (paths: string[]) => paths.map(() => env),
      asrRun: async (jobs: { id: string }[]) =>
        jobs.map((j, i) => ({ id: j.id, text: LINES[i % LINES.length], words: [] })),
      eventsRun: async () => [],
      llmRun: async (requests: unknown[]) => requests.map(() => null),
      setBusyState: () => {},
      notifyDone: () => {}
    }
    ;(globalThis as unknown as { window: unknown }).window = {
      dispatchEvent: () => true,
      api: new Proxy(known, {
        get: (t, k: string) =>
          k in t ? t[k] : k.startsWith('on') ? () => () => {} : () => Promise.resolve()
      })
    }
    useSettingsStore.setState({ aiProvider: 'off', episodeKind: 'location' } as never)
    useProjectStore.getState().newProject('実素材の案')
    await new Promise((r) => setTimeout(r, 0))
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
              path: FILE,
              relativePath: 'tos.mov',
              duration: meta.duration,
              hasVideo: true,
              hasAudio: true
            }
          ]
        }
      ]
    } as never)
    await usePipelineStore.getState().runPipeline()
    usePipelineStore.getState().setTargetMinutes(6)
    await usePipelineStore.getState().rebuildRoughCut()
    const total = mainLength(useProjectStore.getState().project)
    const r = await usePipelineStore
      .getState()
      .prepareRangedVariants({ start: total * 0.08, end: total * 0.62 }, DEFAULT_RANGED_OPTIONS)
    if (!r.ok) throw new Error(r.reason)
    const pipe = (): ReturnType<typeof usePipelineStore.getState> => usePipelineStore.getState()
    const json0 = JSON.stringify(useProjectStore.getState().project)
    const rc0 = JSON.stringify(pipe().roughCut)
    const last = r.previews[r.previews.length - 1]
    // 試して閉じる
    expect(pipe().tryRangedVariant(last, r.previews).ok).toBe(true)
    pipe().cancelRangedTrial()
    expect(JSON.stringify(useProjectStore.getState().project)).toBe(json0)
    expect(JSON.stringify(pipe().roughCut)).toBe(rc0)
    // 決めて取り消す
    expect(pipe().commitRangedVariant(last, r.previews).ok).toBe(true)
    expect(pipe().roughCut?.duration).toBeCloseTo(mainLength(useProjectStore.getState().project), 6)
    useProjectStore.getState().undo()
    expect(JSON.stringify(pipe().roughCut)).toBe(rc0)
  },
  600000
)

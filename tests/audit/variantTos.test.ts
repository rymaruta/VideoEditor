// 1本の長い動画で、範囲の作り直しの案を試して閉じる・決めて取り消す(監査 e1507cb)。
// VARIANT_TOS_FILE に動画のパスを渡せば実素材(Tears of Steel など)で回す
// (例: VARIANT_TOS_FILE=/path/tos720.mov VARIANT_TOS_CACHE=/tmp/cache npx vitest run tests/audit/variantTos.test.ts)。
// 渡さなければ、話す・黙るを繰り返す音の入った 8 分の動画を ffmpeg で作って回す(飛ばさない)
import { expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
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

/** 実素材が無いときの代わり: 8 分・160x90・話す(3〜6 秒)と黙る(1〜2 秒)を繰り返す音 */
function syntheticFootage(dir: string): string {
  const out = join(dir, 'synthetic-tos.mp4')
  if (existsSync(out)) return out
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=24:duration=480',
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.5*sin(2*PI*220*t)*sin(2*PI*3*t)*gt(sin(2*PI*t/7)+0.35,0)':s=16000:d=480",
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    out
  ])
  return out
}
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

it('長い1本の動画: 試して閉じると元のまま、決めて取り消すと仮編集のまとめも戻る', async () => {
  const userData = process.env.VARIANT_TOS_CACHE ?? join(tmpdir(), 'variant-tos')
  mkdirSync(userData, { recursive: true })
  const FILE = process.env.VARIANT_TOS_FILE || syntheticFootage(userData)
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
}, 600000)

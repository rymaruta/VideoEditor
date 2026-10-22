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
import { STEPS, usePipelineStore } from '@renderer/store/pipelineStore'
import { useProjectStore } from '@renderer/store/projectStore'
import { useSettingsStore } from '@renderer/store/settingsStore'
import type { Project } from '@shared/types'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const DURATION = 240
const LINES = [
  'おはようございます、今日はよろしくお願いします',
  'すごい!これは本当に面白いですね!',
  'えっ、ちょっと待って、何それ?',
  'じゃあ次の場所へ移動しましょうか',
  'ここのお店、昔から有名なんですよ',
  'うわー、めっちゃおいしい!最高!',
  'それでは今日はこのへんで、ありがとうございました'
]

function stubApi(): void {
  // 声のある所(0.1秒ごと)。発言の所だけ大きい
  const env = new Float32Array(DURATION * 100)
  for (let i = 0; i < env.length; i++) env[i] = Math.floor(i / 300) % 3 < 2 ? 0.2 : 0.0005
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
    onEventsProgress: () => () => {},
    probeMedia: async () => ({
      duration: DURATION,
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
    footageEnvelopes: async (paths: string[]) => paths.map(() => env),
    asrRun: async (jobs: { id: string; start: number; end: number }[]) =>
      jobs.map((j, i) => ({ id: j.id, text: LINES[i % LINES.length], words: [] })),
    eventsRun: async () => [],
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
}

async function runEpisode(): Promise<void> {
  stubApi()
  useSettingsStore.setState({ aiProvider: 'off', episodeKind: 'location' } as never)
  useProjectStore.getState().newProject('第1回')
  await flush()
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
            duration: DURATION,
            hasVideo: true,
            hasAudio: true
          }
        ]
      }
    ]
  } as never)
  await usePipelineStore.getState().runPipeline()
}

/** 保存(ファイルに書いて読み直す)して、開き直す */
function saveAndReopen(): void {
  const saved = JSON.parse(JSON.stringify(useProjectStore.getState().project)) as Project
  useProjectStore.getState().newProject('別の回')
  useProjectStore.getState().loadProject(saved, '/r/第1回.veproj')
}

describe('自動編集の後に保存して開き直す', () => {
  it('工程の済み・構成・残した場面が戻り、ショートを作れる', async () => {
    await runEpisode()
    // 仕上がりの長さを決めて作り直し、落とす場面も作る
    usePipelineStore.getState().setTargetMinutes(1.5)
    await usePipelineStore.getState().rebuildRoughCut()
    const before = usePipelineStore.getState()
    expect(before.scenes.length).toBeGreaterThan(1)
    expect(before.roughCut!.dropped).toBeGreaterThan(0)
    const doneBefore = STEPS.filter((x) => before.steps[x.id].state === 'done').map((x) => x.id)
    const keptBefore = before.roughCut!.keptIds

    saveAndReopen()
    await flush()
    const after = usePipelineStore.getState()
    // 文字起こしの後の工程まで済みのまま(開き直すと全部「待機・0/14」だった)
    for (const id of doneBefore) expect([id, after.steps[id].state]).toEqual([id, 'done'])
    // 構成の場面と、残した・落とした場面
    expect(after.scenes.map((sc) => [sc.id, sc.start, sc.end])).toEqual(
      before.scenes.map((sc) => [sc.id, sc.start, sc.end])
    )
    expect(after.judgements).toHaveLength(after.scenes.length)
    expect(after.roughCut?.keptIds).toEqual(keptBefore)
    expect(after.roughCut?.telops).toBe(before.roughCut!.telops)
    // 「ショートを作る」「仮編集を作り直す」が押せる条件(場面がある・同期の情報がある・動いていない)
    expect(after.running).toBe(false)
    expect(useProjectStore.getState().project.multicam).toBeTruthy()
    // 作り直せなかったもの(AI の判定・提案の一覧)と、何をやり直せばよいかを画面に出す
    expect(after.restored?.missing.join('\n')).toMatch(/仮編集を作り直す/)

    // 開き直した状態から、仮編集を作り直せる
    await usePipelineStore.getState().rebuildRoughCut()
    expect(usePipelineStore.getState().steps.cut.state).toBe('done')
    expect(usePipelineStore.getState().roughCut?.keptIds).toEqual(keptBefore)
  })

  it('同期・文字起こしの無い企画では何も作らない(新しい企画・手で作った企画)', async () => {
    useProjectStore.getState().newProject('手で作った回')
    await flush()
    const s = usePipelineStore.getState()
    expect(s.restored).toBeNull()
    expect(s.scenes).toHaveLength(0)
    // 取り込み(フォルダの読み取り)は企画の切り替えでも残す
    expect(
      STEPS.filter((x) => x.id !== 'ingest').every((x) => s.steps[x.id].state === 'wait')
    ).toBe(true)
  })
})

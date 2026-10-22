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

/** このPCの AI の答え(演出テロップの提案だけ答える。構成の判定は答えない = 簡易の点数) */
let effectAnswer: (lineIds: string[]) => unknown = () => null

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
    llmRun: async (requests: { schema?: Record<string, unknown> }[]) =>
      requests.map((r) => {
        const props = (r.schema as { properties?: Record<string, unknown> })?.properties
        const effects = props?.effects as
          { items: { properties: { after: { enum: string[] } } } } | undefined
        return effects ? effectAnswer(effects.items.properties.after.enum) : null
      }),
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
  effectAnswer = () => null
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

/** 保存(ファイルに書いて読み直す)して、開き直す。`legacy` なら自動編集の判断の無い古い形式の企画にする */
function saveAndReopen(options: { legacy?: boolean } = {}): void {
  const saved = JSON.parse(JSON.stringify(useProjectStore.getState().project)) as Project
  if (options.legacy) delete (saved as { autoEdit?: unknown }).autoEdit
  useProjectStore.getState().newProject('別の回')
  useProjectStore.getState().loadProject(saved, '/r/第1回.veproj')
}

/** 目標 1.5 分で作り直し(落ちる場面を作る)、落ちた場面を1つ手で残して作り直す。手で残した場面を返す */
async function keepOneDroppedByHand(): Promise<string> {
  usePipelineStore.getState().setTargetMinutes(1.5)
  await usePipelineStore.getState().rebuildRoughCut()
  const s = usePipelineStore.getState()
  const dropped = s.scenes.map((sc) => sc.id).filter((id) => !s.roughCut!.keptIds.includes(id))
  expect(dropped.length).toBeGreaterThan(0)
  const s1 = dropped[0]
  usePipelineStore.getState().setKeep(s1, true)
  await usePipelineStore.getState().rebuildRoughCut()
  expect(usePipelineStore.getState().roughCut!.keptIds).toContain(s1)
  return s1
}

const effectTelops = (): { effectId?: string; text: string; edited?: boolean }[] =>
  useProjectStore
    .getState()
    .project.textOverlays.filter((o) => o.effectId)
    .map((o) => ({ effectId: o.effectId, text: o.text, edited: o.edited }))
    .sort((a, b) => (a.effectId ?? '').localeCompare(b.effectId ?? ''))

/** AI の提案で演出テロップを2枚置き(このPCの AI に頼んで作り直す)、1枚の文字を人が直す */
async function placeAiEffectsAndEditOne(): Promise<void> {
  useSettingsStore.setState({ aiProvider: 'local' } as never)
  effectAnswer = (ids) => ({
    effects: [
      { after: ids[0], kind: 'tsukkomi', text: 'まさかの一言', reason: 'r', confidence: 0.95 },
      { after: ids[1], kind: 'kokoro', text: '(本当かな)', reason: 'r', confidence: 0.95 }
    ]
  })
  // AI を使わない設定で作った回なので、提案の工程は「省略」(作り直しで AI に頼む)
  expect(usePipelineStore.getState().steps.effects.state).not.toBe('done')
  await usePipelineStore.getState().rebuildRoughCut()
  expect(usePipelineStore.getState().steps.effects.state).toBe('done')
  const placed = useProjectStore.getState().project.textOverlays.filter((o) => o.effectId)
  expect(placed.map((o) => o.text).sort()).toEqual(['(本当かな)', 'まさかの一言'].sort())
  const target = placed.find((o) => o.text === 'まさかの一言')!
  useProjectStore.getState().updateTextOverlay(target.id, { text: '人が直した一言' })
  expect(effectTelops().find((o) => o.text === '人が直した一言')?.edited).toBe(true)
  useSettingsStore.setState({ aiProvider: 'off' } as never)
  effectAnswer = () => null
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
    // 自動編集の判断を企画に覚えているので、作り直せなかったものは無い(同期の要約も覚えている)
    expect(after.restored).toEqual({ missing: [], legacy: false })
    expect(useProjectStore.getState().project.autoEdit?.sync?.placed).toBe(1)

    // 開き直した状態から、仮編集を作り直せる
    await usePipelineStore.getState().rebuildRoughCut()
    expect(usePipelineStore.getState().steps.cut.state).toBe('done')
    expect(usePipelineStore.getState().roughCut?.keptIds).toEqual(keptBefore)
  })

  it('手で残した場面と仕上がりの長さが、保存して開き直して作り直しても保たれる', async () => {
    await runEpisode()
    const s1 = await keepOneDroppedByHand()
    const keptBefore = usePipelineStore.getState().roughCut!.keptIds
    // 起動し直した(前の企画の長さ・方針が残っていない)のと同じにする
    saveAndReopen()
    await flush()
    const after = usePipelineStore.getState()
    expect(after.roughCut?.keptIds).toEqual(keptBefore)
    expect(after.keep).toEqual({ [s1]: true })
    expect(after.targetMinutes).toBe(1.5)
    // 何も変えずに作り直す(落ちていた: 手で残した s1 が本編から消えた)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(usePipelineStore.getState().steps.cut.state).toBe('done')
    expect(usePipelineStore.getState().roughCut?.keptIds).toEqual(keptBefore)
    // もう一度保存して開き直しても同じ
    saveAndReopen()
    await flush()
    await usePipelineStore.getState().rebuildRoughCut()
    expect(usePipelineStore.getState().roughCut?.keptIds).toEqual(keptBefore)
  })

  it('AI の判定で残した場面も、開き直して作り直しても落ちない', async () => {
    await runEpisode()
    usePipelineStore.getState().setTargetMinutes(1.5)
    await usePipelineStore.getState().rebuildRoughCut()
    // AI の判定を入れたことにする(簡易の点数では落ちる場面を見どころにする)
    const s = usePipelineStore.getState()
    const dropped = s.scenes.map((sc) => sc.id).filter((id) => !s.roughCut!.keptIds.includes(id))
    const star = dropped[dropped.length - 1]
    usePipelineStore.setState({
      judgeSource: 'ai',
      judgements: s.judgements.map((j) =>
        j.sceneId === star
          ? { ...j, kind: 'highlight', score: 99, title: 'AI の見どころ', reason: 'AI' }
          : { ...j, score: Math.min(j.score, 40) }
      )
    })
    await usePipelineStore.getState().rebuildRoughCut()
    const keptBefore = usePipelineStore.getState().roughCut!.keptIds
    expect(keptBefore).toContain(star)
    saveAndReopen()
    await flush()
    const after = usePipelineStore.getState()
    expect(after.judgeSource).toBe('ai')
    expect(after.judgements.find((j) => j.sceneId === star)?.title).toBe('AI の見どころ')
    await usePipelineStore.getState().rebuildRoughCut()
    expect(usePipelineStore.getState().roughCut?.keptIds).toEqual(keptBefore)
  })

  it('仕上がりの長さ・方針は企画ごと(別の企画を開いたら持ち越さない)', async () => {
    await runEpisode()
    usePipelineStore.getState().setTargetMinutes(1.5)
    usePipelineStore.getState().setEditNote('笑いを優先')
    await usePipelineStore.getState().rebuildRoughCut()
    const first = JSON.parse(JSON.stringify(useProjectStore.getState().project)) as Project
    // 手で作った別の企画を開く: 前の企画の長さ・方針・収録フォルダの読み取りを持ち越さない
    const other = JSON.parse(JSON.stringify(first)) as Project
    delete other.multicam
    delete other.transcript
    delete (other as { autoEdit?: unknown }).autoEdit
    useProjectStore.getState().loadProject(other, '/r/手で作った回.veproj')
    await flush()
    let st = usePipelineStore.getState()
    expect(st.targetMinutes).toBe(0)
    expect(st.editNote).toBe('')
    expect(st.sources).toHaveLength(0)
    expect(st.scan).toBeNull()
    expect(st.steps.ingest.state).toBe('wait')
    // 元の企画を開き直すと、その企画の長さ・方針に戻る
    useProjectStore.getState().loadProject(first, '/r/第1回.veproj')
    await flush()
    st = usePipelineStore.getState()
    expect(st.targetMinutes).toBe(1.5)
    expect(st.editNote).toBe('笑いを優先')
    // 開いた企画の取り込みの欄と、素材の整理(前の回の読み取りを捨てる)が食い違わない
    expect(st.steps.ingest.state).toBe('done')
    expect(st.sources).toHaveLength(0)
  })

  it('古い形式の企画(自動編集の判断が無い)でも、今の本編に残っている場面を残して作り直す', async () => {
    await runEpisode()
    const s1 = await keepOneDroppedByHand()
    const keptBefore = usePipelineStore.getState().roughCut!.keptIds
    saveAndReopen({ legacy: true })
    await flush()
    const after = usePipelineStore.getState()
    expect(after.restored?.legacy).toBe(true)
    expect(after.roughCut?.keptIds).toEqual(keptBefore)
    expect(after.keep[s1]).toBe(true)
    expect(after.targetMinutes).toBe(0)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(usePipelineStore.getState().steps.cut.state).toBe('done')
    expect(usePipelineStore.getState().roughCut?.keptIds).toEqual(keptBefore)
  })

  it('AI の提案で置いた演出テロップ(人が直したものも)が、開き直して AI を使わずに作り直しても残る', async () => {
    await runEpisode()
    await placeAiEffectsAndEditOne()
    const before = effectTelops()
    expect(before).toHaveLength(2)
    saveAndReopen()
    await flush()
    // 提案の一覧と採否が戻る
    const after = usePipelineStore.getState()
    expect(after.effects.filter((e) => e.id.startsWith('fx-'))).toHaveLength(2)
    expect(after.effectChosen.filter((id) => id.startsWith('fx-'))).toHaveLength(2)
    expect(after.steps.effects.state).toBe('done')
    await usePipelineStore.getState().rebuildRoughCut()
    expect(effectTelops()).toEqual(before)
  })

  it('古い形式の企画でも、置いていた演出テロップと人が直したものを作り直しで消さない', async () => {
    await runEpisode()
    await placeAiEffectsAndEditOne()
    const before = effectTelops()
    saveAndReopen({ legacy: true })
    await flush()
    expect(usePipelineStore.getState().steps.effects.state).not.toBe('done')
    // AI を使わない設定
    await usePipelineStore.getState().rebuildRoughCut()
    expect(effectTelops()).toEqual(before)
    // AI を使う設定(提案し直すと ID が変わる): 人が直したものは残り、直していないものは新しい提案に替わる
    saveAndReopen({ legacy: true })
    await flush()
    useSettingsStore.setState({ aiProvider: 'local' } as never)
    effectAnswer = (ids) => ({
      effects: [
        { after: ids[2], kind: 'situation', text: '新しい提案', reason: 'r', confidence: 0.95 }
      ]
    })
    await usePipelineStore.getState().rebuildRoughCut()
    const texts = effectTelops().map((o) => o.text)
    expect(texts).toContain('人が直した一言')
    expect(texts).toContain('新しい提案')
    expect(texts).not.toContain('(本当かな)')
    useSettingsStore.setState({ aiProvider: 'off' } as never)
  })

  it('AI を使う設定でも、提案し直して ID が変わった人が直した演出テロップを消さない', async () => {
    await runEpisode()
    await placeAiEffectsAndEditOne()
    // 提案の工程をやり直させる(AI の設定を替えて頼み直したときと同じ)
    usePipelineStore.setState((s) => ({
      steps: { ...s.steps, effects: { state: 'wait', percent: 0 } }
    }))
    useSettingsStore.setState({ aiProvider: 'local' } as never)
    effectAnswer = (ids) => ({
      effects: [
        { after: ids[0], kind: 'tsukkomi', text: '別の言い方', reason: 'r', confidence: 0.95 }
      ]
    })
    await usePipelineStore.getState().rebuildRoughCut()
    const texts = effectTelops().map((o) => o.text)
    expect(texts).toContain('人が直した一言')
    expect(texts).toContain('別の言い方')
    expect(texts).not.toContain('(本当かな)')
    useSettingsStore.setState({ aiProvider: 'off' } as never)
  })

  it('自動編集の判断が壊れていても開ける(古い企画と同じく今の本編から読み取る)', async () => {
    await runEpisode()
    const keptBefore = usePipelineStore.getState().roughCut!.keptIds
    for (const broken of ['壊れた値', { scenes: '場面' }, { scenes: [{ id: 1 }], keep: 3 }]) {
      const saved = JSON.parse(JSON.stringify(useProjectStore.getState().project)) as Project
      ;(saved as unknown as { autoEdit: unknown }).autoEdit = broken
      useProjectStore.getState().loadProject(saved, '/r/第1回.veproj')
      await flush()
      const st = usePipelineStore.getState()
      expect(st.scenes.length).toBeGreaterThan(0)
      expect(st.roughCut?.keptIds.length ?? 0).toBeGreaterThan(0)
      if (typeof broken === 'string' || typeof broken.scenes === 'string') {
        expect(useProjectStore.getState().project.autoEdit).toBeUndefined()
        expect(st.restored?.legacy).toBe(true)
        expect(st.roughCut?.keptIds).toEqual(keptBefore)
      }
    }
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

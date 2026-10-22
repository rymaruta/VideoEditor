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
import { spansOfClips } from '@shared/roughCut/overrides'
import { LEGACY_NOTE, matchScenesByTime } from '@renderer/lib/pipelineRestore'
import { normalizeAutoEdit } from '@shared/autoEdit'

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

async function runEpisode(beforeRun?: () => void): Promise<void> {
  stubApi()
  effectAnswer = () => null
  useSettingsStore.setState({ aiProvider: 'off', episodeKind: 'location' } as never)
  useProjectStore.getState().newProject('第1回')
  await flush()
  // 新しい回の画面・自動編集の画面で、始める前に決めたもの(仕上がりの長さ・方針)
  beforeRun?.()
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

  it('古い形式の企画(自動編集の判断が無い)では、手で決めた残す/落とすは引き継がず、作り直すと自動の選び方になる', async () => {
    await runEpisode()
    const all = usePipelineStore.getState().scenes.map((sc) => sc.id)
    const full = mainDuration()
    await keepOneDroppedByHand()
    saveAndReopen({ legacy: true })
    await flush()
    const after = usePipelineStore.getState()
    // 案内: 前の版で保存したため手で決めた残す/落とすは残っていない・作り直すと自動の選び方
    expect(after.restored?.legacy).toBe(true)
    expect(after.restored?.missing).toContain(LEGACY_NOTE)
    expect(LEGACY_NOTE).toContain('手で決めた残す/落とす')
    expect(LEGACY_NOTE).toContain('自動の選び方')
    expect(LEGACY_NOTE).toContain('手で詰めた・消した所は守られます')
    expect(after.keep).toEqual({})
    expect(after.targetMinutes).toBe(0)
    // 画面のチェックは、作り直したら残す場面(今の本編から推し量らない)
    expect(after.roughCut?.keptIds).toEqual(all)
    // 手で何かを決めても、企画には「まだ作り直していない古い企画」と覚える(開き直しても案内が出る)
    usePipelineStore.getState().setEditNote('メモ')
    expect(useProjectStore.getState().project.autoEdit?.legacyPending).toBe(true)
    saveAndReopen()
    await flush()
    expect(usePipelineStore.getState().restored?.legacy).toBe(true)
    await usePipelineStore.getState().rebuildRoughCut()
    const st = usePipelineStore.getState()
    expect(st.steps.cut.state).toBe('done')
    // cee37ec(10/09 版と同じ考え方)と同じ: 長さを決めないので全部の場面を残す
    expect(st.roughCut?.keptIds).toEqual(all)
    expect(Math.abs(mainDuration() - full)).toBeLessThan(0.2)
    // 作り直したら、古い企画の案内は消え、企画にも残さない
    expect(st.restored?.legacy).toBe(false)
    expect(st.restored?.missing).not.toContain(LEGACY_NOTE)
    expect(useProjectStore.getState().project.autoEdit?.legacyPending).toBeUndefined()
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

const mainDuration = (): number =>
  useProjectStore
    .getState()
    .project.clips.reduce((t, c) => t + Math.max(0, c.outPoint - c.inPoint) / (c.speed || 1), 0)

/** タイムラインの時刻を共通の時刻にする(今の本編の区間から) */
function commonTimeOf(t: number): number {
  const project = useProjectStore.getState().project
  for (const sp of spansOfClips(project.clips, project.multicam!))
    if (t >= sp.timeline - 1e-6 && t < sp.timeline + (sp.end - sp.start))
      return sp.start + (t - sp.timeline)
  throw new Error(`本編に無い時刻 ${t}`)
}

describe('監査で見つかった不具合(c5fdddd)', () => {
  it('新しい回で決めた仕上がりの長さと方針を、すぐ始めても捨てない', async () => {
    await runEpisode(() => {
      usePipelineStore.getState().setTargetMinutes(1.5)
      usePipelineStore.getState().setEditNote('笑いを優先')
    })
    const s = usePipelineStore.getState()
    expect(s.targetMinutes).toBe(1.5)
    expect(s.editNote).toBe('笑いを優先')
    expect(s.roughCut!.dropped).toBeGreaterThan(0)
    expect(s.roughCut!.duration).toBeLessThan(1.5 * 60 + 15)
    expect(useProjectStore.getState().project.autoEdit?.targetMinutes).toBe(1.5)
    expect(useProjectStore.getState().project.autoEdit?.editNote).toBe('笑いを優先')
  })

  for (const legacy of [false, true])
    it(`手で詰めた本編が、開き直して作り直しても戻らない(${legacy ? '古い形式' : '新しい形式'})`, async () => {
      await runEpisode()
      const clips = useProjectStore.getState().project.clips
      const longest = clips.reduce((a, c) =>
        c.outPoint - c.inPoint > a.outPoint - a.inPoint ? c : a
      )
      const full = mainDuration()
      useProjectStore.getState().updateClipTrim(longest.id, longest.inPoint, longest.outPoint - 3)
      const trimmed = mainDuration()
      expect(full - trimmed).toBeCloseTo(3, 1)
      saveAndReopen({ legacy })
      await flush()
      await usePipelineStore.getState().rebuildRoughCut()
      expect(usePipelineStore.getState().steps.cut.state).toBe('done')
      expect(Math.abs(mainDuration() - trimmed)).toBeLessThan(0.2)
    })

  it('古い形式の企画でも、仕上がりの長さが効く(手で変更と出さない)', async () => {
    await runEpisode()
    const full = usePipelineStore.getState().roughCut!
    expect(full.dropped).toBe(0)
    saveAndReopen({ legacy: true })
    await flush()
    expect(usePipelineStore.getState().keep).toEqual({})
    // 何も変えずに作り直したら同じ場面
    await usePipelineStore.getState().rebuildRoughCut()
    expect(usePipelineStore.getState().roughCut!.keptIds).toEqual(full.keptIds)
    expect(usePipelineStore.getState().keep).toEqual({})
    // 作り直して保存した企画を開き直しても、長さを変えれば効く
    saveAndReopen()
    await flush()
    usePipelineStore.getState().setTargetMinutes(1)
    await usePipelineStore.getState().rebuildRoughCut()
    const after = usePipelineStore.getState()
    expect(after.roughCut!.dropped).toBeGreaterThan(0)
    expect(after.roughCut!.duration).toBeLessThan(full.duration - 30)
    expect(after.keep).toEqual({})
  })

  it('人が直した演出テロップは、その場面を一度落としても、場面を戻せば戻る', async () => {
    await runEpisode()
    await placeAiEffectsAndEditOne()
    saveAndReopen({ legacy: true })
    await flush()
    await usePipelineStore.getState().rebuildRoughCut()
    expect(effectTelops().map((o) => o.text)).toContain('人が直した一言')
    const edited = useProjectStore
      .getState()
      .project.textOverlays.find((o) => o.text === '人が直した一言')!
    const at = commonTimeOf(edited.startTime + 0.05)
    const scene = usePipelineStore.getState().scenes.find((sc) => at >= sc.start && at < sc.end)!
    usePipelineStore.getState().setKeep(scene.id, false)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(effectTelops().map((o) => o.text)).not.toContain('人が直した一言')
    // 保存して開き直しても覚えている
    saveAndReopen()
    await flush()
    usePipelineStore.getState().setKeep(scene.id, true)
    await usePipelineStore.getState().rebuildRoughCut()
    const back = effectTelops().find((o) => o.text === '人が直した一言')
    expect(back?.edited).toBe(true)
    // 二重に置かない
    await usePipelineStore.getState().rebuildRoughCut()
    expect(effectTelops().filter((o) => o.text === '人が直した一言')).toHaveLength(1)
  })

  it('場面の番号がずれても、判定と残す/落とすは時刻の重なる場面に付く', async () => {
    await runEpisode()
    const s1 = await keepOneDroppedByHand()
    const before = usePipelineStore.getState()
    const keptBefore = before.roughCut!.keptIds
    const scene1 = before.scenes.find((sc) => sc.id === s1)!
    const saved = JSON.parse(JSON.stringify(useProjectStore.getState().project)) as Project
    const ae = saved.autoEdit!
    const shift = (id: string): string => `s${Number(id.slice(1)) + 1}`
    ae.scenes = [
      { id: 's1', start: -60, end: -30 },
      ...ae.scenes.map((sc) => ({ ...sc, id: shift(sc.id) }))
    ]
    ae.keep = Object.fromEntries(Object.entries(ae.keep).map(([k, v]) => [shift(k), v]))
    ae.judgements = ae.judgements.map((j) => ({ ...j, sceneId: shift(j.sceneId) }))
    ae.keptIds = ae.keptIds!.map(shift)
    useProjectStore.getState().newProject('別の回')
    useProjectStore.getState().loadProject(saved, '/r/第1回.veproj')
    await flush()
    const after = usePipelineStore.getState()
    expect(after.keep).toEqual({ [s1]: true })
    const kept = after.scenes.find((sc) => sc.id === s1)!
    expect([kept.start, kept.end]).toEqual([scene1.start, scene1.end])
    expect(after.roughCut?.keptIds).toEqual(keptBefore)
    expect(after.judgements.map((j) => j.score)).toEqual(before.judgements.map((j) => j.score))
    expect(after.restored?.missing.join('')).toContain('場面の区切り')
  })
})

/** 今の本編のクリップのうち、共通の時刻で `scene` の中に収まるもの(本編の順) */
function clipsInScene(scene: {
  start: number
  end: number
}): { id: string; start: number; end: number }[] {
  const project = useProjectStore.getState().project
  const spans = spansOfClips(project.clips, project.multicam!)
  expect(spans).toHaveLength(project.clips.length)
  return project.clips
    .map((c, i) => ({ id: c.id, start: spans[i].start, end: spans[i].end }))
    .filter((c) => c.start >= scene.start - 0.2 && c.end <= scene.end + 0.2)
}

describe('監査で見つかった不具合(b4cd4d9)', () => {
  it('古い形式の企画で、場面の大半を手で削って一部だけ残しても、作り直しで残した部分が消えない', async () => {
    await runEpisode()
    const scenes = usePipelineStore.getState().scenes
    const scene = scenes[scenes.length - 1]
    const inside = clipsInScene(scene)
    expect(inside.length).toBeGreaterThan(1)
    // 最後の1本だけ残す(場面の 3 割より短い)
    useProjectStore.getState().removeClips(inside.slice(0, -1).map((c) => c.id))
    const last = inside[inside.length - 1]
    expect(last.end - last.start).toBeLessThan((scene.end - scene.start) * 0.3)
    const before = mainDuration()
    saveAndReopen({ legacy: true })
    await flush()
    await usePipelineStore.getState().rebuildRoughCut()
    expect(usePipelineStore.getState().steps.cut.state).toBe('done')
    expect(usePipelineStore.getState().roughCut!.keptIds).toContain(scene.id)
    expect(Math.abs(mainDuration() - before)).toBeLessThan(0.2)
  })

  for (const reopen of [false, true])
    it(`手で残した場面の中をその後で手で詰めても、作り直しで戻らない(${reopen ? '開き直し' : 'そのまま'})`, async () => {
      await runEpisode()
      const s1 = await keepOneDroppedByHand()
      if (reopen) {
        saveAndReopen()
        await flush()
      }
      const scene = usePipelineStore.getState().scenes.find((sc) => sc.id === s1)!
      const inside = clipsInScene(scene)
      const longest = inside.reduce((a, c) => (c.end - c.start > a.end - a.start ? c : a))
      const clip = useProjectStore.getState().project.clips.find((c) => c.id === longest.id)!
      useProjectStore.getState().updateClipTrim(clip.id, clip.inPoint, clip.outPoint - 3)
      const trimmed = mainDuration()
      await usePipelineStore.getState().rebuildRoughCut()
      expect(usePipelineStore.getState().steps.cut.state).toBe('done')
      expect(usePipelineStore.getState().roughCut!.keptIds).toContain(s1)
      expect(Math.abs(mainDuration() - trimmed)).toBeLessThan(0.2)
      // もう一度作り直しても同じ
      await usePipelineStore.getState().rebuildRoughCut()
      expect(Math.abs(mainDuration() - trimmed)).toBeLessThan(0.2)
    })

  it('場面を一度落として「残す」に戻したときは、前に手で削った所も戻る(10/09 版と同じ)', async () => {
    await runEpisode()
    const full = mainDuration()
    const scene = usePipelineStore.getState().scenes[1]
    const inside = clipsInScene(scene)
    const longest = inside.reduce((a, c) => (c.end - c.start > a.end - a.start ? c : a))
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === longest.id)!
    useProjectStore.getState().updateClipTrim(clip.id, clip.inPoint, clip.outPoint - 3)
    usePipelineStore.getState().setKeep(scene.id, false)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(usePipelineStore.getState().roughCut!.keptIds).not.toContain(scene.id)
    usePipelineStore.getState().setKeep(scene.id, true)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(Math.abs(mainDuration() - full)).toBeLessThan(0.2)
  })
})

describe('matchScenesByTime', () => {
  it('時刻がほぼ同じ場面だけを対応させる(ID は見ない)', () => {
    const prev = [
      { id: 's1', start: 0, end: 100 },
      { id: 's2', start: 100, end: 200 },
      { id: 's3', start: 200, end: 300 }
    ]
    const next = [
      { id: 's1', start: -50, end: 0 },
      { id: 's2', start: 0, end: 98 },
      { id: 's3', start: 98, end: 150 },
      { id: 's4', start: 150, end: 300 }
    ]
    const m = matchScenesByTime(prev, next)
    expect([...m.entries()]).toEqual([['s2', 's1']])
  })
})

describe('監査で見つかった不具合(25b2ade)', () => {
  it('仮編集を取り消した後に作り直しても、「残す」にした場面の昔の削りが戻る', async () => {
    await runEpisode()
    const full = mainDuration()
    const scene = usePipelineStore.getState().scenes[1]
    const inside = clipsInScene(scene)
    const longest = inside.reduce((a, c) => (c.end - c.start > a.end - a.start ? c : a))
    const clip = useProjectStore.getState().project.clips.find((c) => c.id === longest.id)!
    useProjectStore.getState().updateClipTrim(clip.id, clip.inPoint, clip.outPoint - 3)
    usePipelineStore.getState().setKeep(scene.id, false)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(usePipelineStore.getState().roughCut!.keptIds).not.toContain(scene.id)
    usePipelineStore.getState().setKeep(scene.id, true)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(Math.abs(mainDuration() - full)).toBeLessThan(0.2)
    // 取り消すと、場面の落ちた本編に戻る(自動編集の画面の判断・要約は戻らない)
    useProjectStore.getState().undo()
    expect(clipsInScene(scene)).toHaveLength(0)
    await usePipelineStore.getState().rebuildRoughCut()
    expect(usePipelineStore.getState().steps.cut.state).toBe('done')
    expect(usePipelineStore.getState().roughCut!.keptIds).toContain(scene.id)
    expect(Math.abs(mainDuration() - full)).toBeLessThan(0.2)
  })
})

/** 目標 1.5 分で作り直し、落ちた場面を1つ返す */
async function dropOne(): Promise<{ id: string; start: number; end: number }> {
  usePipelineStore.getState().setTargetMinutes(1.5)
  await usePipelineStore.getState().rebuildRoughCut()
  const s = usePipelineStore.getState()
  const dropped = s.scenes.filter((sc) => !s.roughCut!.keptIds.includes(sc.id))
  expect(dropped.length).toBeGreaterThan(0)
  return dropped[0]
}

/** 同じ収録のカメラ素材から、共通の時刻 `at` からの `len` 秒を本編の `atTime` へ差し込む */
function insertFromRecording(at: number, len: number, atTime: number): void {
  const project = useProjectStore.getState().project
  const f = project.multicam!.files[0]
  const src = (at - f.start) * f.rate
  useProjectStore.getState().insertClipAtTime(f.assetId, src, src + len * f.rate, atTime)
}

/** 本編の中の、場面のクリップ(真ん中の時刻が場面にあるもの。本編の順)を本編の頭へ動かす(場面の入れ替え) */
function moveSceneToFront(scene: { start: number; end: number }): void {
  const project = useProjectStore.getState().project
  const spans = spansOfClips(project.clips, project.multicam!)
  project.clips
    .filter((_, i) => {
      const mid = (spans[i].start + spans[i].end) / 2
      return mid >= scene.start && mid < scene.end
    })
    .forEach((c, i) => useProjectStore.getState().moveClipToIndex(c.id, i))
}

/** 場面の中のいちばん長いクリップのお尻を `sec` 秒詰める */
function trimInScene(scene: { start: number; end: number }, sec: number): void {
  const inside = clipsInScene(scene)
  const longest = inside.reduce((a, c) => (c.end - c.start > a.end - a.start ? c : a))
  const clip = useProjectStore.getState().project.clips.find((c) => c.id === longest.id)!
  useProjectStore.getState().updateClipTrim(clip.id, clip.inPoint, clip.outPoint - sec)
}

const rebuild = async (): Promise<{ kept: string[]; duration: number }> => {
  await usePipelineStore.getState().rebuildRoughCut()
  const st = usePipelineStore.getState()
  expect(st.steps.cut.state).toBe('done')
  return { kept: st.roughCut!.keptIds, duration: mainDuration() }
}

/**
 * 監査の再現手順を、古い形式・新しい形式の両方で。古い形式の期待は cee37ec(c5fdddd の前。10/09 版と
 * 同じ考え方)と同じ結果(git worktree の cee37ec で同じ手順を走らせて確かめた値)、かつ手の削りは守る。
 * 古い形式は判断が残っていないので、長さを決めない自動の選び方 = 全部の場面を残す(この素材では
 * s1 0〜97.5・s2 97.5〜196.5・s3 196.5〜240)
 */
describe('開き直して作り直す回帰(古い形式・新しい形式)', () => {
  for (const legacy of [true, false]) {
    const label = legacy ? '古い形式' : '新しい形式'
    const reopen = async (): Promise<void> => {
      saveAndReopen({ legacy })
      await flush()
    }

    it(`新しい回で長さ 1.5 分にしてすぐ始め、開き直して作り直す(${label})`, async () => {
      await runEpisode(() => usePipelineStore.getState().setTargetMinutes(1.5))
      const before = {
        kept: usePipelineStore.getState().roughCut!.keptIds,
        duration: mainDuration()
      }
      expect(before.duration).toBeLessThan(1.5 * 60 + 15)
      await reopen()
      const r = await rebuild()
      if (legacy) {
        // 長さは前の版の企画に残っていない: 全部の場面(cee37ec: s1〜s3・214.8 秒)
        expect(r.kept).toEqual(['s1', 's2', 's3'])
        expect(r.duration).toBeCloseTo(214.8, 0)
      } else expect(r).toEqual({ kept: before.kept, duration: expect.closeTo(before.duration, 1) })
    })

    it(`手で残した場面を開き直して作り直す(${label})`, async () => {
      await runEpisode()
      const full = mainDuration()
      const s1 = await keepOneDroppedByHand()
      const before = {
        kept: usePipelineStore.getState().roughCut!.keptIds,
        duration: mainDuration()
      }
      await reopen()
      const r = await rebuild()
      expect(r.kept).toContain(s1)
      if (legacy) {
        expect(r.kept).toEqual(['s1', 's2', 's3'])
        expect(Math.abs(r.duration - full)).toBeLessThan(0.2)
      } else expect(Math.abs(r.duration - before.duration)).toBeLessThan(0.2)
    })

    it(`人が直した演出テロップを開き直して作り直す(${label})`, async () => {
      await runEpisode()
      await placeAiEffectsAndEditOne()
      const before = effectTelops()
      await reopen()
      await rebuild()
      // cee37ec では作り直すと消えていた(c5fdddd で直したもの)。どちらの形式でも残す
      expect(effectTelops()).toEqual(before)
    })

    it(`手で3秒詰めて開き直して作り直す(${label})`, async () => {
      await runEpisode()
      const full = mainDuration()
      trimInScene(usePipelineStore.getState().scenes[0], 3)
      await reopen()
      const r = await rebuild()
      expect(r.kept).toEqual(['s1', 's2', 's3'])
      expect(Math.abs(r.duration - (full - 3))).toBeLessThan(0.2)
    })

    it(`場面の大半を手で削って一部だけ残し、開き直して作り直す(${label})`, async () => {
      await runEpisode()
      const scenes = usePipelineStore.getState().scenes
      const inside = clipsInScene(scenes[scenes.length - 1])
      useProjectStore.getState().removeClips(inside.slice(0, -1).map((c) => c.id))
      const before = mainDuration()
      await reopen()
      const r = await rebuild()
      expect(r.kept).toEqual(['s1', 's2', 's3'])
      expect(Math.abs(r.duration - before)).toBeLessThan(0.2)
    })

    it(`落とした場面から短いカットを差し込み、開き直して作り直す(${label})`, async () => {
      await runEpisode()
      const full = mainDuration()
      const s1 = await dropOne()
      const keptIds = usePipelineStore.getState().roughCut!.keptIds
      insertFromRecording((s1.start + s1.end) / 2, 1.5, 5)
      const before = mainDuration()
      await reopen()
      const r = await rebuild()
      if (legacy) {
        // cee37ec と同じ: 長さが残っていないので全部の場面(差し込んだ所は戻った場面に入る)
        expect(r.kept).toEqual(['s1', 's2', 's3'])
        expect(Math.abs(r.duration - full)).toBeLessThan(0.2)
      } else {
        // 保存した判断(1.5 分)で同じ場面。差し込みで落とした場面は戻らない
        expect(r.kept).toEqual(keptIds)
        expect(r.kept).not.toContain(s1.id)
        expect(Math.abs(r.duration - before)).toBeLessThan(0.2)
      }
    })

    it(`隣り合う2場面の順を入れ替え、開き直して作り直しても場面が消えない(${label})`, async () => {
      await runEpisode()
      const full = mainDuration()
      const scenes = usePipelineStore.getState().scenes
      expect(scenes.map((sc) => [sc.id, sc.start, sc.end]).slice(0, 2)).toEqual([
        ['s1', 0, 97.5],
        ['s2', 97.5, 196.5]
      ])
      moveSceneToFront(scenes[1])
      await reopen()
      // ac0e4c8 では s1 を「落とした」と読み、作り直すと 214.8 → 126.8 秒になっていた
      expect(usePipelineStore.getState().roughCut!.keptIds).toEqual(['s1', 's2', 's3'])
      const r = await rebuild()
      expect(r.kept).toEqual(['s1', 's2', 's3'])
      expect(Math.abs(r.duration - full)).toBeLessThan(0.2)
    })

    it(`残すにした場面の中を詰めてから入れ替えても、作り直しで詰めた所が戻らない(${label})`, async () => {
      await runEpisode()
      const s1 = await keepOneDroppedByHand()
      const scene = usePipelineStore.getState().scenes.find((sc) => sc.id === s1)!
      trimInScene(scene, 3)
      moveSceneToFront(scene)
      const trimmed = mainDuration()
      // 開き直さずに(cee37ec では詰めた3秒が戻っていた)
      let r = await rebuild()
      expect(r.kept).toContain(s1)
      expect(Math.abs(r.duration - trimmed)).toBeLessThan(0.2)
      await reopen()
      r = await rebuild()
      expect(r.kept).toContain(s1)
      if (legacy) {
        // 長さ(1.5 分)が残っていないので全部の場面。詰めた所は守る
        expect(r.kept).toEqual(['s1', 's2', 's3'])
        expect(clipsInScene(scene).length).toBeGreaterThan(0)
      } else expect(Math.abs(r.duration - trimmed)).toBeLessThan(0.2)
    })

    it(`残す場面の中を後から詰めても、作り直すと戻らない(開き直した後・${label})`, async () => {
      await runEpisode()
      const full = mainDuration()
      const s1 = await keepOneDroppedByHand()
      await reopen()
      const scene = usePipelineStore.getState().scenes.find((sc) => sc.id === s1)!
      trimInScene(scene, 3)
      const trimmed = mainDuration()
      // 古い形式では、手で決めた「残す」が無いので、画面で残すにし直す(画面で既に残す場面なので削りは戻さない)
      if (legacy) usePipelineStore.getState().setKeep(s1, true)
      const r = await rebuild()
      expect(r.kept).toContain(s1)
      // 古い形式は長さ(1.5 分)が残っていないので全部の場面。s1 の中の詰めた3秒は戻らない
      expect(Math.abs(r.duration - (legacy ? full - 3 : trimmed))).toBeLessThan(0.2)
      expect(Math.abs((await rebuild()).duration - r.duration)).toBeLessThan(0.2)
    })

    it(`開き直してから落として戻し、Ctrl+Z の後に作り直すと昔の削りが戻る(${label})`, async () => {
      await runEpisode()
      const full = mainDuration()
      const scene = usePipelineStore.getState().scenes[1]
      trimInScene(scene, 3)
      await reopen()
      usePipelineStore.getState().setKeep(scene.id, false)
      expect((await rebuild()).kept).not.toContain(scene.id)
      usePipelineStore.getState().setKeep(scene.id, true)
      expect(Math.abs((await rebuild()).duration - full)).toBeLessThan(0.2)
      useProjectStore.getState().undo()
      expect(clipsInScene(scene)).toHaveLength(0)
      // cee37ec と同じ: 214.8 秒(昔の削りも戻る)
      const r = await rebuild()
      expect(r.kept).toContain(scene.id)
      expect(Math.abs(r.duration - full)).toBeLessThan(0.2)
    })

    it(`長さの欄に数字を入れて消してから作り直す(${label})`, async () => {
      await runEpisode()
      const full = mainDuration()
      usePipelineStore.getState().setTargetMinutes(1.5)
      await usePipelineStore.getState().rebuildRoughCut()
      const before = {
        kept: usePipelineStore.getState().roughCut!.keptIds,
        duration: mainDuration()
      }
      await reopen()
      const typed = usePipelineStore.getState().targetMinutes
      usePipelineStore.getState().setTargetMinutes(2)
      usePipelineStore.getState().setTargetMinutes(typed)
      const r = await rebuild()
      if (legacy) {
        expect(typed).toBe(0)
        expect(r.kept).toEqual(['s1', 's2', 's3'])
        expect(Math.abs(r.duration - full)).toBeLessThan(0.2)
      } else {
        expect(typed).toBe(1.5)
        expect(r.kept).toEqual(before.kept)
        expect(Math.abs(r.duration - before.duration)).toBeLessThan(0.2)
      }
    })

    it(`作り直しが当たらなかった後に作り直す(${label})`, async () => {
      await runEpisode()
      const full = mainDuration()
      await dropOne()
      const before = usePipelineStore.getState().roughCut!.keptIds
      await reopen()
      const shown = usePipelineStore.getState().roughCut!.keptIds
      const typed = usePipelineStore.getState().targetMinutes
      usePipelineStore.getState().setTargetMinutes(2)
      const running = usePipelineStore.getState().rebuildRoughCut()
      // 作っている最中に本編を直す(作り直しは当たらない)
      const c = useProjectStore.getState().project.clips[0]
      useProjectStore.getState().updateClipTrim(c.id, c.inPoint, c.outPoint - 0.5)
      await running
      expect(usePipelineStore.getState().steps.cut.state).toBe('error')
      // 当たらなかったので、画面の残す場面・古い企画の案内はそのまま
      expect(usePipelineStore.getState().roughCut!.keptIds).toEqual(shown)
      expect(usePipelineStore.getState().restored?.legacy).toBe(legacy)
      usePipelineStore.getState().setTargetMinutes(typed)
      const r = await rebuild()
      if (legacy) {
        // cee37ec と同じ: 全部の場面・途中で詰めた 0.5 秒は守る(214.3 秒)
        expect(r.kept).toEqual(['s1', 's2', 's3'])
        expect(Math.abs(r.duration - (full - 0.5))).toBeLessThan(0.2)
      } else expect(r.kept).toEqual(before)
    })
  }

  it('取り消しで前の作り直しに戻っても、その回の残す/落とすと比べる(残す場面の中の詰めを戻さない)', async () => {
    await runEpisode()
    const s1 = await keepOneDroppedByHand()
    const scene = usePipelineStore.getState().scenes.find((sc) => sc.id === s1)!
    trimInScene(scene, 3)
    const trimmed = mainDuration()
    expect(Math.abs((await rebuild()).duration - trimmed)).toBeLessThan(0.2)
    // 作り直しを取り消す(本編は、前の作り直し + 手の詰め に戻る)
    useProjectStore.getState().undo()
    expect(Math.abs(mainDuration() - trimmed)).toBeLessThan(0.2)
    // 前の作り直しでも s1 は残していたので、詰めた所は戻さない(cee37ec では戻っていた)
    const r = await rebuild()
    expect(r.kept).toContain(s1)
    expect(Math.abs(r.duration - trimmed)).toBeLessThan(0.2)
    // 作り直しの回ごとの残した場面は企画に覚える(保存して開き直しても比べられる)
    expect(useProjectStore.getState().project.autoEdit?.builtKept?.length).toBeGreaterThan(1)
  })

  it('作り直しを取り消してから保存して開き直しても、取り消した後の本編を組んだ回の残す/落とすと比べる', async () => {
    await runEpisode()
    const full = mainDuration()
    const scene = usePipelineStore.getState().scenes[1]
    trimInScene(scene, 3)
    usePipelineStore.getState().setKeep(scene.id, false)
    expect((await rebuild()).kept).not.toContain(scene.id)
    usePipelineStore.getState().setKeep(scene.id, true)
    expect(Math.abs((await rebuild()).duration - full)).toBeLessThan(0.2)
    useProjectStore.getState().undo()
    expect(clipsInScene(scene)).toHaveLength(0)
    saveAndReopen()
    await flush()
    expect(usePipelineStore.getState().keep).toEqual({ [scene.id]: true })
    const r = await rebuild()
    expect(r.kept).toContain(scene.id)
    expect(Math.abs(r.duration - full)).toBeLessThan(0.2)
  })

  it('前回の残す/落とすが分からない企画では、手で残すにした場面の昔の削りを戻す(10/09 版と同じ)', async () => {
    await runEpisode()
    const full = mainDuration()
    const scene = usePipelineStore.getState().scenes[1]
    trimInScene(scene, 3)
    usePipelineStore.getState().setKeep(scene.id, false)
    expect((await rebuild()).kept).not.toContain(scene.id)
    // 覚えている作り直しの回に、今の組んだ本編が無い(取り消しで覚えている回より前まで戻った など)
    const saved = JSON.parse(JSON.stringify(useProjectStore.getState().project)) as Project
    saved.autoEdit!.builtKept = [{ cut: '0:0', keptIds: ['s1', 's2', 's3'] }]
    useProjectStore.getState().newProject('別の回')
    useProjectStore.getState().loadProject(saved, '/r/第1回.veproj')
    await flush()
    usePipelineStore.getState().setKeep(scene.id, true)
    const r = await rebuild()
    expect(r.kept).toContain(scene.id)
    expect(Math.abs(r.duration - full)).toBeLessThan(0.2)
  })

  it('前の版(b4cd4d9〜ac0e4c8)で今の本編から読み取った残す/落とす(timelineKeep)は読み捨てる', async () => {
    await runEpisode()
    const all = usePipelineStore.getState().scenes.map((sc) => sc.id)
    await dropOne()
    const saved = JSON.parse(JSON.stringify(useProjectStore.getState().project)) as Project
    const ae = saved.autoEdit as unknown as Record<string, unknown>
    // その版の企画: 読み取った残す/落とすと、読み取った残した場面。長さは 0 にした
    ae.timelineKeep = { s1: false, s2: false, s3: true }
    ae.keptIds = ['s3']
    ae.targetMinutes = 0
    delete ae.builtKept
    expect(normalizeAutoEdit(ae)).not.toHaveProperty('timelineKeep')
    expect(normalizeAutoEdit(ae)?.legacyPending).toBe(true)
    useProjectStore.getState().newProject('別の回')
    useProjectStore.getState().loadProject(saved, '/r/第1回.veproj')
    await flush()
    const st = usePipelineStore.getState()
    expect(useProjectStore.getState().project.autoEdit).not.toHaveProperty('timelineKeep')
    expect(st.restored?.legacy).toBe(true)
    expect(st.restored?.missing).toContain(LEGACY_NOTE)
    // 画面のチェックは作り直したら残す場面(読み取った s3 だけではない)
    expect(st.roughCut!.keptIds).toEqual(all)
    const r = await rebuild()
    expect(r.kept).toEqual(all)
    expect(useProjectStore.getState().project.autoEdit).not.toHaveProperty('timelineKeep')
  })
})

describe('古い形式の企画の画面のチェック(乱択)', () => {
  /** 決まった種から作る乱数(mulberry32) */
  function rng(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('本編をどう直しても、開き直した画面の残す場面が作り直した結果と一致し、手で詰めた長さは戻らない', async () => {
    for (let round = 0; round < 12; round++) {
      const rand = rng(500 + round)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]
      await runEpisode()
      usePipelineStore.getState().setTargetMinutes(pick([0, 1, 1.5, 3]))
      for (const sc of usePipelineStore.getState().scenes)
        if (rand() < 0.3) usePipelineStore.getState().setKeep(sc.id, rand() < 0.5)
      await usePipelineStore.getState().rebuildRoughCut()
      const scenes = usePipelineStore.getState().scenes
      const kept = scenes.filter((sc) =>
        usePipelineStore.getState().roughCut!.keptIds.includes(sc.id)
      )
      if (kept.length > 1 && rand() < 0.5) moveSceneToFront(kept[kept.length - 1])
      let trimmed = 0
      for (const sc of kept)
        if (rand() < 0.4 && clipsInScene(sc).some((c) => c.end - c.start > 4)) {
          trimInScene(sc, 2)
          trimmed += 2
        }
      const before = mainDuration()
      saveAndReopen({ legacy: true })
      await flush()
      const shown = usePipelineStore.getState().roughCut!.keptIds
      const r = await rebuild()
      expect([round, r.kept]).toEqual([round, shown])
      // 戻った場面の分だけ長くなるが、手で詰めた所は戻らない(全部の場面 − 詰めた秒数 以下)
      expect(r.duration).toBeGreaterThanOrEqual(before - 0.2)
      if (r.kept.length === scenes.length) expect(r.duration).toBeLessThan(214.8 - trimmed + 0.2)
    }
  }, 60_000)
})

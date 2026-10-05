import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@renderer/store/projectStore'
import { audioClipDuration } from '@renderer/lib/timelineMath'
import { normalizeTextStyle } from '@shared/textStyle'
import type { Project } from '@shared/types'
import { seeded } from '../helpers/boundary'

/**
 * **開く(読み込み)の性質テスト。**
 *
 * `.veproj` は外から来る JSON。どこがどう壊れていても、
 * - 開くことは投げない
 * - 開いた結果は、この先のコードが前提にしている形(下の `brokenInvariant`)を満たす
 * - 開く → 保存 → 開くで中身が変わらない(保存のたびに少しずつずれていかない)
 * を、決まった種の乱数で何千通りも当てる。落ちたら表示される `muts` がそのまま再現手順。
 */

const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()

/** 分離音声・追従テロップ・PiP・BGM を全部持った土台(`projectStore.test.ts` と同じ形) */
function baseProject(): Project {
  return {
    id: 'p',
    name: 'inv',
    aspectRatio: '16:9',
    assets: [
      {
        id: 'A',
        filePath: '/x/a.mp4',
        fileName: 'a.mp4',
        duration: 10,
        width: 1280,
        height: 720,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      },
      {
        id: 'B',
        filePath: '/x/b.mp4',
        fileName: 'b.mp4',
        duration: 8,
        width: 1280,
        height: 720,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      },
      {
        id: 'M',
        filePath: '/x/m.m4a',
        fileName: 'm.m4a',
        duration: 20,
        width: 0,
        height: 0,
        fps: 0,
        hasAudio: true,
        hasVideo: false
      }
    ],
    clips: [
      { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1, audioDetached: true },
      { id: 'c2', assetId: 'B', inPoint: 1, outPoint: 5, speed: 1 },
      { id: 'c3', assetId: 'A', inPoint: 2, outPoint: 6, speed: 1 }
    ],
    audioTracks: [
      {
        id: 't1',
        name: 'BGM',
        volume: 1,
        muted: false,
        duckingEnabled: false,
        clips: [
          { id: 'a1', assetId: 'M', startTime: 6, inPoint: 0, outPoint: 5, volume: 1, speed: 1 }
        ]
      },
      {
        id: 't2',
        name: '分離音声',
        volume: 1,
        muted: false,
        duckingEnabled: false,
        clips: [
          {
            id: 'a2',
            assetId: 'A',
            startTime: 0,
            inPoint: 0,
            outPoint: 4,
            volume: 1,
            speed: 1,
            linkedClipId: 'c1'
          }
        ]
      }
    ],
    videoOverlayTracks: [
      {
        id: 'v1',
        name: 'PiP',
        hidden: false,
        position: 'top-right',
        scale: 0.3,
        clips: [{ id: 'p1', assetId: 'B', startTime: 2, inPoint: 0, outPoint: 3 }]
      }
    ],
    textOverlays: [
      {
        id: 'o1',
        text: 'あ',
        startTime: 1,
        endTime: 3,
        style: {},
        source: 'manual',
        linkedClipId: 'c1',
        linkOffset: 1
      },
      { id: 'o2', text: 'い', startTime: 5, endTime: 7, style: {}, source: 'manual' }
    ],
    beatGrid: null
  } as unknown as Project
}

/** どこかに有限でない数が残っていれば、その場所を返す */
function nonFinitePath(v: unknown, path = ''): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? null : path
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = nonFinitePath(x, `${path}.${k}`)
      if (p) return p
    }
  }
  return null
}

/** 開いたプロジェクトが満たしていなければならないこと。破れていればその理由 */
function brokenInvariant(p: Project): string | null {
  for (const key of ['assets', 'clips', 'audioTracks', 'videoOverlayTracks', 'textOverlays']) {
    if (!Array.isArray((p as unknown as Record<string, unknown>)[key])) return `${key} が配列でない`
  }
  if (p.audioTracks.some((t) => !Array.isArray(t.clips))) return '音声トラックの clips が配列でない'
  if (p.videoOverlayTracks.some((t) => !Array.isArray(t.clips))) return 'PiP の clips が配列でない'
  const nf = nonFinitePath(p)
  if (nf) return `有限でない数: ${nf}`

  const unique = (ids: string[]): boolean => new Set(ids).size === ids.length
  const clipIds = p.clips.map((c) => c.id)
  if (!unique(p.assets.map((a) => a.id))) return '素材IDが重複'
  if (!unique(clipIds)) return '本編クリップIDが重複'
  if (!unique(p.audioTracks.flatMap((t) => t.clips.map((c) => c.id)))) return '音声クリップIDが重複'
  if (!unique(p.videoOverlayTracks.flatMap((t) => t.clips.map((c) => c.id))))
    return 'PiPクリップIDが重複'
  if (!unique(p.textOverlays.map((o) => o.id))) return 'テロップIDが重複'

  const ids = new Set(clipIds)
  if (p.audioTracks.flatMap((t) => t.clips).some((c) => c.linkedClipId && !ids.has(c.linkedClipId)))
    return '音声の linkedClipId が居ないクリップを指す'
  if (p.textOverlays.some((o) => o.linkedClipId && !ids.has(o.linkedClipId)))
    return 'テロップの linkedClipId が居ないクリップを指す'

  const dur = new Map(p.assets.map((a) => [a.id, a.duration]))
  /** 尺0は「まだ分からない」の意味なので上限は見ない */
  const rangeOk = (c: { inPoint: number; outPoint: number }, d: number): boolean =>
    c.inPoint >= 0 && c.outPoint > c.inPoint && (d <= 0 || c.outPoint <= d + 1e-9)

  for (const c of p.clips) {
    const d = dur.get(c.assetId)
    if (d === undefined) return `本編クリップ ${c.id} が居ない素材を指す`
    if (!rangeOk(c, d)) return `本編クリップ ${c.id} の範囲が不正 in=${c.inPoint} out=${c.outPoint}`
    if (!(c.speed > 0)) return `本編クリップ ${c.id} の速度が不正`
  }
  for (const c of p.audioTracks.flatMap((t) => t.clips)) {
    const d = dur.get(c.assetId)
    if (d === undefined) return `音声クリップ ${c.id} が居ない素材を指す`
    if (!(c.startTime >= 0) || !rangeOk(c, d)) return `音声クリップ ${c.id} の範囲が不正`
    if (!(audioClipDuration(c) > 0)) return `音声クリップ ${c.id} の長さが正でない`
  }
  for (const c of p.videoOverlayTracks.flatMap((t) => t.clips)) {
    const d = dur.get(c.assetId)
    if (d === undefined) return `PiP ${c.id} が居ない素材を指す`
    if (!(c.startTime >= 0) || !rangeOk(c, d)) return `PiP ${c.id} の範囲が不正`
  }
  for (const o of p.textOverlays) {
    if (!(o.startTime >= 0 && o.endTime >= o.startTime)) return `テロップ ${o.id} の範囲が不正`
    if (!o.style || typeof o.style.color !== 'string') return `テロップ ${o.id} の見た目が欠けている`
  }
  return null
}

/** 外から読んだ JSON に入りうる、ろくでもない値 */
const NASTY: unknown[] = [
  null,
  'NaN',
  'Infinity',
  -5,
  -1e9,
  0,
  1e308,
  -1e308,
  99999,
  '',
  'x',
  true,
  {},
  [],
  [null],
  undefined // = 項目ごと消す
]

type Path = (string | number)[]

function allPaths(o: unknown, pre: Path = [], out: Path[] = []): Path[] {
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      const p = [...pre, Array.isArray(o) ? Number(k) : k]
      out.push(p)
      allPaths(v, p, out)
    }
  }
  return out
}

function setAt(root: unknown, p: Path, v: unknown): boolean {
  let o = root as Record<string | number, unknown>
  for (let i = 0; i < p.length - 1; i++) {
    const next = o?.[p[i]]
    if (!next || typeof next !== 'object') return false
    o = next as Record<string | number, unknown>
  }
  if (!o || typeof o !== 'object') return false
  if (v === undefined) delete o[p[p.length - 1]]
  else o[p[p.length - 1]] = v
  return true
}

type Raw = Record<string, unknown> & {
  clips: Record<string, unknown>[]
  audioTracks: { clips: Record<string, unknown>[] }[]
  videoOverlayTracks: { clips: Record<string, unknown>[] }[]
  textOverlays: Record<string, unknown>[]
}

/** 型の崩れだけでなく、**整合性**の崩れ(重複ID・宙に浮いた参照・逆さの範囲)も作る */
const structural: { name: string; run: (p: Raw, rnd: () => number) => void }[] = [
  { name: '本編IDを重複', run: (p) => (p.clips[1].id = p.clips[0].id) },
  { name: '音声IDを重複', run: (p) => (p.audioTracks[0].clips[0].id = 'a2') },
  { name: 'PiPのIDを本編と同じに', run: (p) => (p.videoOverlayTracks[0].clips[0].id = 'c1') },
  { name: 'テロップIDを重複', run: (p) => (p.textOverlays[1].id = 'o1') },
  { name: '素材IDを重複', run: (p) => ((p.assets as Record<string, unknown>[])[1].id = 'A') },
  { name: 'クリップが居ない素材を指す', run: (p) => (p.clips[2].assetId = 'ZZ') },
  { name: '音声が居ない素材を指す', run: (p) => (p.audioTracks[1].clips[0].assetId = 'ZZ') },
  { name: '音声の紐づき先が居ない', run: (p) => (p.audioTracks[1].clips[0].linkedClipId = 'ZZ') },
  { name: 'テロップの紐づき先が居ない', run: (p) => (p.textOverlays[0].linkedClipId = 'ZZ') },
  {
    name: '本編の in/out が逆',
    run: (p, rnd) => {
      p.clips[Math.floor(rnd() * 3)].inPoint = 9
    }
  },
  { name: '音声の out<in', run: (p) => (p.audioTracks[0].clips[0].outPoint = -5) },
  { name: 'PiP の in が素材の外', run: (p) => (p.videoOverlayTracks[0].clips[0].inPoint = 99999) },
  { name: 'テロップ end<start', run: (p) => (p.textOverlays[1].endTime = 2) },
  { name: '追従テロップの start が巨大', run: (p) => (p.textOverlays[0].startTime = 1e308) },
  { name: '本編IDなし', run: (p) => delete p.clips[0].id },
  { name: 'clips が文字列', run: (p) => (p.clips = 'こわれた' as unknown as []) },
  { name: '音声トラックの clips が null', run: (p) => (p.audioTracks[0].clips = null as never) }
]

function loadRaw(raw: unknown): Project {
  st().loadProject(JSON.parse(JSON.stringify(raw)) as Project, '/tmp/fuzz.veproj')
  return st().project
}

/** 保存と同じ道(JSON 文字列)を通した形 */
const asSaved = (p: Project): unknown => JSON.parse(JSON.stringify(p))

describe('【性質】壊れた .veproj を開いても、形が整い、保存し直してもずれない', () => {
  it('無傷の土台はそのまま開け、開く→保存→開くで変わらない', () => {
    const first = loadRaw(baseProject())
    expect(brokenInvariant(first)).toBeNull()
    expect(asSaved(loadRaw(asSaved(first)))).toEqual(asSaved(first))
  })

  it.each(structural.map((m) => [m.name, m] as const))('%s', (_name, m) => {
    const raw = JSON.parse(JSON.stringify(baseProject())) as Raw
    m.run(raw, seeded(1))
    const first = loadRaw(raw)
    expect(brokenInvariant(first)).toBeNull()
    expect(asSaved(loadRaw(asSaved(first)))).toEqual(asSaved(first))
  })

  it('ランダムに壊した 1500 通り: 投げない・形が整う・保存し直してもずれない', () => {
    const rnd = seeded(20261005)
    const failures: string[] = []
    for (let i = 0; i < 1500 && failures.length < 5; i++) {
      const raw = JSON.parse(JSON.stringify(baseProject())) as Raw
      const muts: string[] = []
      if (rnd() < 0.3) {
        const m = structural[Math.floor(rnd() * structural.length)]
        try {
          m.run(raw, rnd)
          muts.push(m.name)
        } catch {
          // 先に壊した値のせいで当てられない組み合わせは飛ばす
        }
      }
      const paths = allPaths(raw)
      const n = 1 + Math.floor(rnd() * 3)
      for (let j = 0; j < n; j++) {
        const p = paths[Math.floor(rnd() * paths.length)]
        // 複製して入れる(同じオブジェクトを入れると、続く書き換えが NASTY 自体を壊す)
        const picked = NASTY[Math.floor(rnd() * NASTY.length)]
        const v = picked === undefined ? undefined : structuredClone(picked)
        if (setAt(raw, p, v)) muts.push(`${p.join('.')}=${v === undefined ? '(削除)' : JSON.stringify(v)}`)
      }
      const label = `#${i} ${muts.join(' / ')}`
      let first: Project
      try {
        first = loadRaw(raw)
      } catch (e) {
        failures.push(`${label} → 投げた: ${String(e)}`)
        continue
      }
      const broken = brokenInvariant(first)
      if (broken) {
        failures.push(`${label} → ${broken}`)
        continue
      }
      const saved = asSaved(first)
      let again: unknown
      try {
        again = asSaved(loadRaw(saved))
      } catch (e) {
        failures.push(`${label} → 開き直しで投げた: ${String(e)}`)
        continue
      }
      if (JSON.stringify(again) !== JSON.stringify(saved)) {
        failures.push(`${label} → 開く→保存→開くでずれた`)
      }
    }
    expect(failures).toEqual([])
  })
})

describe('【レグレッション】尺の分からないファイルへ再リンクしても、クリップが尺0に潰れない', () => {
  it('probe の尺が 0 なら、その素材のクリップの範囲はそのまま', () => {
    const before = loadRaw(baseProject())
    st().relinkAsset('A', '/y/a2.mp4', 'a2.mp4', {
      duration: 0,
      width: 1280,
      height: 720,
      fps: 30,
      hasAudio: true,
      hasVideo: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      needsPreviewProxy: false
    }, undefined)
    const after = st().project
    expect(after.clips.map((c) => [c.inPoint, c.outPoint])).toEqual(
      before.clips.map((c) => [c.inPoint, c.outPoint])
    )
    expect(after.audioTracks[1].clips[0].outPoint).toBe(4)
  })
})

describe('【性質】テロップの見た目の正規化は、何度通しても同じで、数は有限', () => {
  const VALUES: unknown[] = [
    ...NASTY,
    0.5,
    -360,
    720,
    150,
    'red',
    'popIn',
    'radial',
    { x: 1e308, y: 'a' },
    { x: 0.2, y: 0.8 },
    { side: 'top', at: 5, length: -1 },
    { stops: [{ at: 2, color: 'red' }, { at: -1 }, null], angle: 1e308 },
    [{ width: 3, color: '' }, { width: -1 }, null],
    { color: '', size: 1e9, opacity: -1 },
    { scale: 99, color: 'red' }
  ]
  const KEYS = Object.keys(normalizeTextStyle(undefined)).concat([
    'customPosition',
    'extraStrokes',
    'fontWeight',
    'fillGradient',
    'outlineGradient',
    'backgroundGradient',
    'opacity',
    'lineHeight',
    'align',
    'shadowAngle',
    'shadowBlur',
    'glow',
    'backgroundPadding',
    'backgroundBorder',
    'bubbleTail',
    'firstLine',
    'accent',
    'pointer',
    'arc',
    'charAnimation',
    'exitAnimation',
    'loopAnimation',
    'animationSpeed',
    'gradientColor',
    'unknownFutureKey'
  ])

  it('3000 通り', () => {
    const rnd = seeded(7)
    const failures: string[] = []
    for (let i = 0; i < 3000 && failures.length < 5; i++) {
      const raw: Record<string, unknown> = {}
      for (const k of KEYS) {
        if (rnd() < 0.35) raw[k] = structuredClone(VALUES[Math.floor(rnd() * VALUES.length)])
      }
      const input = JSON.stringify(raw)
      let once: unknown
      try {
        once = JSON.parse(JSON.stringify(normalizeTextStyle(JSON.parse(input))))
      } catch (e) {
        failures.push(`${input} → 投げた: ${String(e)}`)
        continue
      }
      const nf = nonFinitePath(once)
      if (nf) failures.push(`${input} → 有限でない ${nf}`)
      const twice = JSON.parse(JSON.stringify(normalizeTextStyle(once)))
      if (JSON.stringify(twice) !== JSON.stringify(once)) failures.push(`${input} → 2回目で変わった`)
    }
    expect(failures).toEqual([])
  })

  it('オブジェクトでないものは既定の見た目になる', () => {
    for (const v of NASTY) expect(normalizeTextStyle(v)).toEqual(normalizeTextStyle(undefined))
  })
})

describe('【レグレッション】壊れた localStorage でも設定は起動し、無事な分は残る', () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function settingsWith(
    entries: Record<string, string>
  ): Promise<ReturnType<(typeof import('@renderer/store/settingsStore'))['useSettingsStore']['getState']>> {
    store.clear()
    for (const [k, v] of Object.entries(entries)) store.set(k, v)
    vi.resetModules()
    const mod = await import('@renderer/store/settingsStore')
    return mod.useSettingsStore.getState()
  }

  const FILL = [{ id: 'f', name: '赤', values: { color: '#ff0000' } }]

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'マイ設定の項目名が "%s" でも、ほかの項目のマイ設定は消えない',
    async (bad) => {
      const raw = `{${JSON.stringify(bad)}:[{"id":"a","name":"b","values":{}}],"fill":${JSON.stringify(FILL)}}`
      const s = await settingsWith({ 've-section-presets': raw })
      expect(Object.keys(s.sectionPresets)).toEqual(['fill'])
      expect(s.sectionPresets.fill.map((p) => [p.id, p.values.color])).toEqual([['f', '#ff0000']])
    }
  )

  it.each([
    ['壊れた JSON', '{"fill":['],
    ['null', 'null'],
    ['配列', '[1,2]'],
    ['数', '42'],
    ['項目が配列でない', '{"fill":"x","stroke":null}'],
    ['要素が壊れている', '{"fill":[null,1,"a",{"id":1,"name":"x"},{"id":"ok","name":"n","values":"bad"}]}']
  ])('マイ設定が %s でも起動できる', async (_name, raw) => {
    const s = await settingsWith({ 've-section-presets': raw })
    expect(typeof s.sectionPresets).toBe('object')
    for (const list of Object.values(s.sectionPresets)) {
      expect(Array.isArray(list)).toBe(true)
      for (const p of list) {
        expect(typeof p.id).toBe('string')
        expect(nonFinitePath(p.values)).toBeNull()
      }
    }
  })

  it('色・グラデーション・書き出し設定が全部壊れていても既定値で起動する', async () => {
    const s = await settingsWith({
      've-favorite-colors': '{not json',
      've-recent-colors': '[null, 5, "#GGGGGG", "#ff0000", "#FF0000"]',
      've-favorite-gradients': '[{"id":"g","gradient":{"stops":[{"at":"x"}]}}, null, {"id":"h","gradient":{"angle":5,"stops":[{"at":0,"color":"red"},{"at":1,"color":"blue"}]}}]',
      've-show-style': '"string"',
      've-export-resolution': 'NaN',
      've-export-quality': 'ultra',
      've-ai-provider': '__proto__'
    })
    expect(s.favoriteColors).toEqual([])
    expect(s.recentColors).toEqual(['#ff0000'])
    expect(s.favoriteGradients.map((g) => g.id)).toEqual(['h'])
    expect(s.showStyle).toBeNull()
    expect(s.exportResolutionHeight).toBe(1080)
    expect(s.exportQuality).toBe('high')
    expect(s.aiProvider).toBe('local')
  })

  it('お気に入りのテロップ(presetStore)の中身が壊れていても、直して残す', async () => {
    store.set(
      've-caption-presets',
      JSON.stringify([
        { id: 'a', name: 'n', style: { color: 5, fontSize: 'big', fillGradient: { stops: 1 } } },
        null,
        { id: 'b', name: 'n2', style: null },
        { id: 'c', name: 'n3', style: {}, speakers: [1, '', ' ', 'A'] }
      ])
    )
    vi.resetModules()
    const { usePresetStore } = await import('@renderer/store/presetStore')
    const presets = usePresetStore.getState().captionPresets
    expect(presets.map((p) => p.id)).toEqual(['a', 'c'])
    for (const p of presets) {
      expect(typeof p.style.color).toBe('string')
      expect(nonFinitePath(p.style)).toBeNull()
    }
    expect(presets[1].speakers).toEqual(['A'])
  })
})

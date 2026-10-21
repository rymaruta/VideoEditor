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
import * as NP from '../../src/renderer/src/lib/roughCutPlan'
import * as NM from '@shared/telop/manual'
import * as OP from './fixtures/telop01b3ed7/roughCutPlan'
import * as OM from './fixtures/telop01b3ed7/manual'
import { TURN_RATE } from '@shared/diarize/micTurns'
import { defaultTextStyle } from '@shared/textStyle'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Project, TextOverlay } from '@shared/types'

const info: MulticamInfo = {
  anchorSourceId: 'cam',
  sources: [
    { id: 'cam', name: '画面', kind: 'camera', cameraRole: 'screen' },
    { id: 'a', name: 'A', kind: 'mic' }
  ],
  files: [
    { assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: 100 },
    { assetId: 'MA', sourceId: 'a', start: 0, rate: 1, duration: 100 }
  ]
}
type W = { text: string; start: number; end: number }
type Auto = Omit<TextOverlay, 'id'> & NM.WithAutoSource
function project(words: W[]): { p: Project; activity: Uint8Array } {
  const u = {
    id: 'u0',
    assetId: 'MA',
    speaker: 'A',
    sourceStart: words[0].start,
    sourceEnd: words[words.length - 1].end,
    text: words.map((w) => w.text).join(''),
    words,
    overlap: false
  }
  const activity = new Uint8Array(100 * TURN_RATE)
  activity.fill(1, Math.floor(u.sourceStart * TURN_RATE), Math.ceil(u.sourceEnd * TURN_RATE))
  return {
    p: {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [],
      clips: [],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: [],
      transcript: [u],
      multicam: info
    } as unknown as Project,
    activity
  }
}
function plan(
  impl: 'old' | 'new',
  g: ReturnType<typeof project>,
  start: number,
  end: number,
  dictionary: { from: string; to: string }[],
  lineChars = 14
): Auto[] {
  const f = (impl === 'old' ? OP.planRoughCut : NP.planRoughCut) as typeof NP.planRoughCut
  return f(
    g.p,
    info,
    [{ id: 's0', start, end, lines: [], speech: 0 }],
    [{ sceneId: 's0', score: 100, kind: 'highlight', reason: '' }],
    g.activity,
    {
      targetSec: 0,
      keep: { s0: true },
      styles: [],
      speechLook: { style: defaultTextStyle() },
      kind: 'game',
      policy: 'light',
      dictionary,
      style: { telopLineChars: lineChars } as never
    }
  ).telops as Auto[]
}
/** 保存して開き直す(今の版で読み込む) */
const save = <T>(x: T): T =>
  JSON.parse(JSON.stringify(x), (k, v) => (k === 'autoSource' ? NM.normalizeAutoSource(v) : v))
const show = (ts: readonly Omit<TextOverlay, 'id'>[]): string =>
  ts.map((t) => `${t.edited ? '*' : ''}${t.text.replace(/\n/g, '')}`).join(' | ')
const ids = (ts: readonly Auto[]): TextOverlay[] =>
  ts.map((t, i) => ({ ...t, id: `t${i}` })) as TextOverlay[]

describe('前の版(01b3ed7)で保存した、辞書で直した文字の範囲', () => {
  const dict = [{ from: '三丌丏', to: '言訁訂訃訄' }]

  it('頭を落とした「言訁訂訃訄丒丕」を消して開き直し、カットを広げても、消した言葉は戻らない', () => {
    const g = project([
      { text: '一七丆', start: 1.0, end: 1.6 },
      { text: '三丌丏', start: 1.7, end: 2.3 },
      { text: '丒丕', start: 2.4, end: 2.8 }
    ])
    const timeline = ids(plan('old', g, 1.45, 3.5, dict))
    const victim = timeline.find((t) => t.text.includes('言'))!
    const saved = save({
      timeline: timeline.filter((t) => t !== victim),
      dismissed: [OM.autoTelopKey(victim)!]
    })
    const merged = NM.mergeManualTelops(
      saved.timeline,
      plan('new', g, 0.5, 3.5, dict),
      new Set(saved.dismissed)
    )
    // 直す前(dc65a0d)は「一七丆言」(直した言葉の最初の文字が戻った)
    expect(show(merged)).toBe('一七丆')
  })

  it('終わりを落とした枚を消した・直したのを開き直しても、前の版のまま作り直したのと同じ', () => {
    const g = project([
      { text: '一七', start: 1.0, end: 1.4 },
      { text: '三丌丏', start: 1.5, end: 2.1 },
      { text: '丒丕', start: 2.2, end: 2.6 }
    ])
    const timeline = ids(plan('old', g, 0.5, 2.3, dict))
    const victim = timeline.find((t) => t.text.includes('言'))!
    const deleted = save({
      timeline: timeline.filter((t) => t !== victim),
      dismissed: [OM.autoTelopKey(victim)!]
    })
    const edited = save(
      timeline.map((t) => (t === victim ? { ...t, text: 'EDIT', edited: true } : t))
    )
    const wide = (impl: 'old' | 'new'): Auto[] => plan(impl, g, 0.5, 3.0, dict)
    const mergedNew = NM.mergeManualTelops(
      deleted.timeline,
      wide('new'),
      new Set(deleted.dismissed)
    )
    const mergedOld = OM.mergeManualTelops(
      deleted.timeline,
      wide('old'),
      new Set(deleted.dismissed)
    )
    expect(show(mergedNew)).toBe(show(mergedOld))
    // 直す前は「*EDIT | 訁訂訃訄丒丕」(直した言葉が2回出た)
    expect(show(NM.mergeManualTelops(edited, wide('new'), new Set()))).toBe(
      show(OM.mergeManualTelops(edited, wide('old'), new Set()))
    )
  })

  it('辞書で直した言葉だけの枚を直したのを開き直しても、直した文字は消えない', () => {
    const g = project([
      { text: '一七', start: 1.0, end: 1.4 },
      { text: '三丌丏', start: 1.5, end: 2.1 },
      { text: '丒丕', start: 2.2, end: 2.6 }
    ])
    const tl = ids(plan('old', g, 1.45, 2.15, dict))
    const edited = save(
      tl.map((t) => (t.text.includes('言') ? { ...t, text: 'EDIT', edited: true } : t))
    )
    const merged = NM.mergeManualTelops(edited, plan('new', g, 0.5, 3.0, dict), new Set())
    expect(show(merged)).toBe('一七 | *EDIT | 丒丕')
  })
})

describe('辞書で長くなって何枚かに分けた枚', () => {
  it('カットで頭を落としても、同じ言葉が2枚に出ない', () => {
    const g = project([
      { text: '一丁', start: 1.0, end: 1.55 },
      { text: '丂七', start: 1.6, end: 1.94 },
      { text: '丄丅', start: 1.99, end: 2.34 },
      { text: '丆万', start: 2.39, end: 2.93 }
    ])
    const dict = [
      { from: '丂七', to: '言訁訂訃訄' },
      { from: '丄丅', to: '訅訆訇' }
    ]
    const all = plan('new', g, 1.91, 4.4, dict, 5)
      .map((x) => x.text.replace(/\s/g, ''))
      .join('')
    expect(all.split('訆').length - 1).toBe(1)
    expect(all.split('訇').length - 1).toBe(1)
  })

  it('カットで終わりを落としても、残した範囲で話している言葉は消えない', () => {
    const g = project([
      { text: '一七', start: 1.0, end: 1.4 },
      { text: '丒丕', start: 1.5, end: 1.9 },
      { text: '三丌', start: 2.0, end: 2.4 },
      { text: '丘丛', start: 2.5, end: 2.9 }
    ])
    const telops = plan('new', g, 0.5, 3.0, [{ from: '三丌', to: '言訁訂訃訄訅訆訇計訉' }], 4)
    const all = telops.map((t) => t.text.replace(/\s/g, '')).join('')
    expect(all).toContain('丘')
    expect(all).toContain('計')
    // 分けた枚の時刻は、それぞれの枚の文字を話している時刻(文字数で割り振らない)
    const last = telops.find((t) => t.text.includes('計'))!
    expect(last.startTime).toBeGreaterThan(1.75)
  })
})

describe('切り分けた枚の時刻・言いよどみの切れ端', () => {
  it('長い間の後の残りの枚は声から出し、直した枚は声の終わりで消す', () => {
    const g = project([
      { text: '一七', start: 1.0, end: 1.4 },
      { text: '丒丕', start: 3.0, end: 3.4 }
    ])
    const tl = ids(plan('new', g, 0.5, 4.0, [], 2))
    const edited = save(
      tl.map((t) => (t.text === '一七' ? { ...t, text: 'EDITED', edited: true } : t))
    )
    const merged = NM.mergeManualTelops(edited, plan('new', g, 0.5, 4.0, [], 14), new Set())
    const rest = merged.find((t) => t.text === '丒丕')!
    const edit = merged.find((t) => t.edited)!
    // 声はタイムラインの 0.50〜0.90(一七)と 2.50〜2.90(丒丕)。直す前は間の真ん中(1.7)で区切っていた
    expect(rest.startTime).toBeGreaterThan(2.5 - 0.15)
    expect(edit.endTime).toBeLessThan(0.9 + 0.15)
  })

  it('当てた文字が言いよどみの切れ端だけの修正は出さない', () => {
    const style = defaultTextStyle()
    const piece: Auto = {
      text: 'と 亥',
      startTime: 0,
      endTime: 1,
      style,
      source: 'auto',
      speaker: 'A',
      utteranceId: 'u0',
      utteranceChunk: 1,
      autoSource: { start: 10, end: 11, text: 'と 亥', times: [10.2, 10.8], offset: -10 }
    }
    // 前の作り直しで「えっと 亥」の「えっと」の枚(10.0〜10.3)を直したが、今は「と」しか当たらない
    const merged = NM.mergeManualTelops([], [piece], new Set(), {
      'u:u0#0@9.900-10.300': {
        text: '直した',
        style,
        autoSource: { start: 9.9, end: 10.3, text: 'えっと' }
      } as never
    })
    expect(show(merged)).toBe('亥')
  })
})

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
import { planRoughCut } from '../../src/renderer/src/lib/roughCutPlan'
import {
  autoTelopKey,
  mergeManualTelops,
  rememberEditedTelops,
  type WithAutoSource
} from '@shared/telop/manual'
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
type Auto = Omit<TextOverlay, 'id'> & WithAutoSource
function plan(
  utterances: W[][],
  scenes: { start: number; end: number }[],
  lineChars: number,
  dictionary: { from: string; to: string }[] = []
): Auto[] {
  const transcript = utterances.map((words, k) => ({
    id: `u${k}`,
    assetId: 'MA',
    speaker: 'A',
    sourceStart: words[0].start,
    sourceEnd: words[words.length - 1].end,
    text: words.map((w) => w.text).join(''),
    words,
    overlap: false
  }))
  const project = {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [],
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    transcript,
    multicam: info
  } as unknown as Project
  const activity = new Uint8Array(100 * TURN_RATE).fill(1, 0, 10 * TURN_RATE)
  const sc = scenes.map((s, i) => ({ id: `s${i}`, ...s, lines: [], speech: 0 }))
  return planRoughCut(
    project,
    info,
    sc,
    sc.map((s) => ({ sceneId: s.id, score: 100, kind: 'highlight' as const, reason: '' })),
    activity,
    {
      targetSec: 0,
      keep: Object.fromEntries(sc.map((s) => [s.id, true])),
      styles: [],
      speechLook: { style: defaultTextStyle() },
      kind: 'game',
      policy: 'light',
      dictionary,
      style: { telopLineChars: lineChars } as never
    }
  ).telops as Auto[]
}
const ids = (ts: readonly Auto[]): TextOverlay[] =>
  ts.map((t, i) => ({ ...t, id: `t${i}` })) as TextOverlay[]

describe('相づち・言いよどみに似た言葉を直したテロップ', () => {
  for (const reply of ['そう', 'うん', 'ええ', 'そうそう', 'あの', 'あと', 'まま', 'はい', 'えっ'])
    for (const kind of ['text', 'style'] as const)
      it(`「${reply}」を直して(${kind === 'text' ? '文字' : '見た目'})1行の長さを替えても、修正が消えない`, () => {
        const us: W[][] = [
          [{ text: '今日は配信します', start: 1, end: 2.2 }],
          [{ text: reply, start: 3, end: 3.4 }],
          [{ text: '始めましょう', start: 4.5, end: 5.4 }]
        ]
        const timeline = ids(plan(us, [{ start: 0, end: 7 }], 14)).map((t) =>
          t.utteranceId !== 'u1'
            ? t
            : kind === 'text'
              ? { ...t, text: `${reply}!`, edited: true }
              : { ...t, style: { ...t.style, fontSize: 99 }, edited: true }
        )
        const merged = mergeManualTelops(
          timeline,
          plan(us, [{ start: 0, end: 7 }], 10),
          new Set(),
          rememberEditedTelops(timeline, undefined)
        )
        // 直す前は修正も言葉も消えていた(言いよどみの切れ端とみなした)
        const mine = merged.filter((t) => t.utteranceId === 'u1')
        expect(mine.map((t) => [t.text, t.edited])).toEqual([
          [kind === 'text' ? `${reply}!` : reply, true]
        ])
      })
})

describe('長さ 0 の言葉の短い範囲', () => {
  it('長さ 0 の「はい」の枚を消しても、隣の辞書の言葉は消えない', () => {
    const words: W[] = [
      { text: '今日はいい天気ですね、', start: 0.5, end: 2.0 },
      { text: 'はい、', start: 3.0, end: 3.0 },
      { text: 'えー、', start: 3.0, end: 3.4 },
      { text: 'きむら', start: 4.4, end: 4.8 },
      { text: 'です', start: 4.8, end: 5.1 }
    ]
    const dict = [{ from: 'きむら', to: '木村' }]
    const first = ids(
      plan(
        [words],
        [
          { start: 2.9, end: 3.35 },
          { start: 4.3, end: 5.3 }
        ],
        14,
        dict
      )
    )
    const hai = first.find((t) => t.text.replace(/\s/g, '') === 'はい')!
    expect(hai).toBeDefined()
    const merged = mergeManualTelops(
      first.filter((t) => t !== hai),
      plan([words], [{ start: 0, end: 6 }], 14, dict),
      new Set([autoTelopKey(hai)!])
    )
    const texts = merged.map((t) => t.text.replace(/\s/g, ''))
    expect(texts.join('|')).toContain('木村')
    expect(texts).not.toContain('はい')
  })
})

describe('伸ばした語尾の文字の時刻', () => {
  // 「今日は」(0.3 秒) 「ね」(1.2 秒、伸ばした語尾) 長い間 「配信します」
  const words: W[] = [
    { text: '今日は', start: 1.0, end: 1.3 },
    { text: 'ね', start: 1.3, end: 2.5 },
    { text: '配信します', start: 4.0, end: 4.5 }
  ]
  it('切り分けた「今日はね」の枚は、「ね」を言い終わるまで出す', () => {
    const narrow = ids(plan([words], [{ start: 0, end: 6 }], 4))
    const i = narrow.findIndex((t) => t.text.replace(/\s/g, '').includes('配信'))
    expect(i).toBeGreaterThanOrEqual(0)
    narrow[i] = { ...narrow[i], text: '配信します!', edited: true }
    const wide = plan([words], [{ start: 0, end: 6 }], 14)
    const merged = mergeManualTelops(narrow, wide, new Set())
    const a = merged.find((t) => t.text.replace(/\s/g, '') === '今日はね')!
    expect(a).toBeDefined()
    // タイムライン = 素材の時刻 + offset。「ね」の声の終わり 2.5 秒
    const end = 2.5 + wide[0].autoSource!.offset!
    expect(end - a.endTime).toBeLessThanOrEqual(0.15)
  })

  it('話している長さを覚えていない枚(前の版)でも、長い間の向こうへは延ばしすぎない', () => {
    const times = [1.05, 1.15, 1.25, 1.9, 4.05, 4.15, 4.25, 4.35, 4.45]
    const host: Auto = {
      text: '今日はね配信します',
      startTime: 1.0,
      endTime: 4.5,
      style: defaultTextStyle(),
      source: 'auto',
      speaker: 'A',
      utteranceId: 'u0',
      utteranceChunk: 0,
      autoSource: { start: 0.998, end: 4.502, text: '今日はね配信します', times, offset: 0 }
    }
    const out = mergeManualTelops([], [host], new Set(), {
      'u:u0#1@3.998-4.502': {
        text: '配信します!',
        style: defaultTextStyle(),
        autoSource: {
          start: 3.998,
          end: 4.502,
          text: '配信します',
          times: times.slice(4),
          offset: 0
        }
      } as never
    })
    const a = out.find((t) => t.text === '今日はね')!
    expect(2.5 - a.endTime).toBeLessThanOrEqual(0.15)
    expect(a.endTime).toBeLessThan(3.0)
  })
})

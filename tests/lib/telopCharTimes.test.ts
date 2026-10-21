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
import { autoTelopKey, mergeManualTelops, type WithAutoSource } from '@shared/telop/manual'
import { telopCharTimes, utteranceToTelopChunks } from '@shared/telop/fromTranscript'
import { TURN_RATE } from '@shared/diarize/micTurns'
import { defaultTextStyle } from '@shared/textStyle'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Project, TextOverlay } from '@shared/types'
import { perfBudget } from '../perfBudget'

const info: MulticamInfo = {
  anchorSourceId: 'cam',
  sources: [
    { id: 'cam', name: '画面', kind: 'camera', cameraRole: 'screen' },
    { id: 'a', name: 'A', kind: 'mic' }
  ],
  files: [
    { assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: 4000 },
    { assetId: 'MA', sourceId: 'a', start: 0, rate: 1, duration: 4000 }
  ]
}
type W = { text: string; start: number; end: number }
type Auto = Omit<TextOverlay, 'id'> & WithAutoSource
const utt = (words: W[]): Project['transcript'] extends (infer U)[] | undefined ? U : never =>
  ({
    id: 'u0',
    assetId: 'MA',
    speaker: 'A',
    sourceStart: words[0].start,
    sourceEnd: words[words.length - 1].end,
    text: words.map((w) => w.text).join(''),
    words,
    overlap: false
  }) as never
function plan(
  words: W[],
  scene: [number, number],
  lineChars: number,
  dictionary?: { from: string; to: string }[]
): Auto[] {
  const project = {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [],
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    transcript: [utt(words)],
    multicam: info
  } as unknown as Project
  const activity = new Uint8Array(4000 * TURN_RATE)
  for (const w of words)
    activity.fill(1, Math.floor(w.start * TURN_RATE), Math.ceil(w.end * TURN_RATE))
  return planRoughCut(
    project,
    info,
    [{ id: 's', start: scene[0], end: scene[1], lines: [], speech: 0 }],
    [{ sceneId: 's', score: 100, kind: 'highlight', reason: '' }],
    activity,
    {
      targetSec: 0,
      keep: { s: true },
      styles: [],
      speechLook: { style: defaultTextStyle() },
      kind: 'game',
      policy: 'light',
      dictionary,
      style: { telopLineChars: lineChars } as never
    }
  ).telops as Auto[]
}
const flat = (ts: readonly { text: string }[]): string =>
  ts.map((t) => t.text.replace(/\s/g, '')).join(' | ')

describe('発言テロップの文字ごとの話している時刻', () => {
  // 両 两 [丧个中 → 言] [丰丳丶 → 訁訂訃訄訅]
  const words: W[] = [
    { text: '両', start: 7.168, end: 7.415 },
    { text: '两', start: 7.634, end: 7.89 },
    { text: '丧个中', start: 8.11, end: 8.62 },
    { text: '丰丳丶', start: 8.816, end: 9.396 }
  ]
  const dict = [
    { from: '丧个中', to: '言' },
    { from: '丰丳丶', to: '訁訂訃訄訅' }
  ]

  it('辞書で直した文字は、直す前の言葉を話している時刻(最初の合わない言葉の時刻に寄せない)', () => {
    const u = utt(words)
    const [chunk] = utteranceToTelopChunks(u, { dictionary: dict })
    const times = telopCharTimes(u, chunk, chunk.text)!
    expect(times.length).toBe(8)
    // 「言」は丧个中(8.11〜8.62)、「訁訂訃訄訅」は丰丳丶(8.816〜9.396)を前から順に受け持つ
    expect(times[2]).toBeGreaterThan(8.11)
    expect(times[2]).toBeLessThan(8.62)
    for (const t of times.slice(-5)) {
      expect(t).toBeGreaterThan(8.8)
      expect(t).toBeLessThan(9.4)
    }
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('長い言いよどみの後の言葉も、その言葉の時刻', () => {
    const fw: W[] = [
      { text: '丹', start: 15.487, end: 15.612 },
      { text: 'まあ、', start: 15.698, end: 16.574 },
      { text: 'えー、', start: 16.721, end: 17.278 },
      { text: 'えっと、', start: 17.328, end: 17.844 },
      { text: 'えっと、', start: 17.972, end: 18.679 },
      { text: '丼', start: 18.756, end: 19.007 }
    ]
    const u = utt(fw)
    const [chunk] = utteranceToTelopChunks(u)
    const times = telopCharTimes(u, chunk, chunk.text)!
    expect(times.at(-1)!).toBeGreaterThan(18.75)
  })

  it('頭を落とした枚「両两言」を消してカットを広げても、出していなかった「訁訂訃訄訅」は消えない', () => {
    const clipped = plan(words, [6.5, 8.7], 14, dict)
    expect(flat(clipped)).toBe('両两言')
    const full = plan(words, [6.5, 10], 14, dict)
    expect(flat(mergeManualTelops([], full, new Set([autoTelopKey(clipped[0])!])))).toBe(
      '訁訂訃訄訅'
    )
  })

  it('辞書で行数を超えて分けた枚を1枚消しても、ほかの枚の言葉は消えない', () => {
    const ws: W[] = [
      { text: '一七', start: 1, end: 1.62 },
      { text: '丆', start: 2.247, end: 2.375 },
      { text: '三丌', start: 2.582, end: 2.853 },
      { text: '丏丒丕', start: 2.886, end: 3.466 },
      { text: '丘丛', start: 3.52, end: 3.992 },
      { text: '丞両', start: 4.59, end: 5.072 },
      { text: '两丧个', start: 5.222, end: 5.588 },
      { text: '中丰丳', start: 5.788, end: 6.346 }
    ]
    const d = [
      { from: '丞両', to: '言訁訂訃訄' },
      { from: '中丰丳', to: '訅訆訇計' }
    ]
    const ps = plan(ws, [0, 7], 10, d)
    expect(ps.length).toBeGreaterThan(1)
    // どの枚の範囲にも、ほかの枚の文字の時刻は入らない
    for (const a of ps)
      for (const b of ps)
        if (a !== b)
          for (const t of b.autoSource!.times!)
            expect(t < a.autoSource!.start || t > a.autoSource!.end).toBe(true)
    for (const a of ps) {
      const merged = mergeManualTelops([], plan(ws, [0, 7], 16, d), new Set([autoTelopKey(a)!]))
      const shown = new Set([...flat(merged)])
      const mine = new Set([...a.text])
      const lost = ps
        .filter((b) => b !== a)
        .flatMap((b) => [...b.text.replace(/\s/g, '')])
        .filter((c) => !shown.has(c) && !mine.has(c))
      expect(lost).toEqual([])
    }
  })

  it('負の時刻の範囲も鍵から読める(消した印が当たる)', () => {
    const piece: Auto = {
      text: '一二',
      startTime: 0,
      endTime: 1,
      style: defaultTextStyle(),
      source: 'auto',
      utteranceId: 'u0',
      utteranceChunk: 0,
      autoSource: { start: -0.002, end: 0.8, text: '一二', times: [0.2, 0.6] }
    }
    const key = autoTelopKey(piece)!
    expect(key).toBe('u:u0#0@0.000-0.800')
    expect(mergeManualTelops([], [piece], new Set([key]))).toEqual([])
  })
})

describe('切り分けた枚の時刻', () => {
  // 「今日は」をゆっくり(1.0〜2.4 秒)、続けて「すごいボスを倒します」を速く(2.5〜3.5 秒)
  const words: W[] = [
    { text: '今日は', start: 1.0, end: 2.4 },
    { text: 'すごい', start: 2.5, end: 2.8 },
    { text: 'ボスを', start: 2.85, end: 3.15 },
    { text: '倒します', start: 3.2, end: 3.5 }
  ]
  it('直した言葉の枚は声の終わりまで、残りの枚は残りの声から出す(文字数で割り振らない)', () => {
    const narrow = plan(words, [0, 5], 2)
    const timeline: TextOverlay[] = narrow.map((t, i) => ({ ...t, id: `t${i}` }))
    const i = timeline.findIndex((x) => x.text.replace(/\s/g, '') === '今日は')
    expect(i).toBeGreaterThanOrEqual(0)
    timeline[i] = { ...timeline[i], text: '今日は!', edited: true }
    const wide = plan(words, [0, 5], 14)
    const merged = mergeManualTelops(timeline, wide, new Set())
    const edited = merged.find((t) => t.edited)!
    const rest = merged.find((t) => !t.edited)!
    // タイムライン = 素材の時刻 - offset(カットの頭)
    const offset = wide[0].autoSource!.offset!
    expect(Math.abs(edited.endTime - (2.4 + offset))).toBeLessThan(0.15)
    expect(Math.abs(rest.startTime - (2.5 + offset))).toBeLessThan(0.15)
  })

  it('消した残りの数文字の枚も 0.3 秒以上出す(一瞬で消えない)', () => {
    const times = Array.from({ length: 10 }, (_, k) => 10 + k * 0.1 + 0.05)
    const piece: Auto = {
      text: '一二三四五六七八九十',
      startTime: 5,
      endTime: 6,
      style: defaultTextStyle(),
      speaker: 'A',
      source: 'auto',
      utteranceId: 'u0',
      utteranceChunk: 0,
      autoSource: { start: 10, end: 11, text: '一二三四五六七八九十', times }
    }
    // 前の作り直しで「一二三四五六七八九」を1枚で出し、人が消した
    const merged = mergeManualTelops([], [piece], new Set(['u:u0#0@10.048-10.902']))
    expect(flat(merged)).toBe('十')
    for (const t of merged) expect(t.endTime - t.startTime).toBeGreaterThanOrEqual(0.3)
    expect(merged[0].endTime).toBeLessThanOrEqual(6)
  })
})

describe('長い発話の仮編集の速さ', () => {
  it('8,000 語の発話1つでも、枚ごとに発話全体を数え直さない', () => {
    const KANA =
      'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん今日配信始見話面白楽'
    const longWords: W[] = Array.from({ length: 8000 }, (_, i) => ({
      text: KANA[i % KANA.length] + KANA[(i * 7) % KANA.length],
      start: 1 + i * 0.25,
      end: 1 + i * 0.25 + 0.2
    }))
    plan(longWords.slice(0, 200), [0, 60], 14)
    const t0 = performance.now()
    const telops = plan(longWords, [0, 2010], 14)
    const ms = performance.now() - t0
    expect(telops.length).toBeGreaterThan(100)
    // 直す前は 1,135 ms(直した後は約 100 ms)
    expect(ms).toBeLessThan(perfBudget(500))
  })
})

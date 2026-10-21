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
import { buildShortProject } from '../../src/renderer/src/lib/gameShorts'
import {
  effectOverlays,
  placedAutoTelops,
  planRoughCut
} from '../../src/renderer/src/lib/roughCutPlan'
import { useProjectStore } from '@renderer/store/projectStore'
import { planCg } from '@shared/finish/cg'
import { autoTelopKey, mergeManualTelops, rememberEditedTelops } from '@shared/telop/manual'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { EffectProposal } from '@shared/telop/effects'
import type { Project, TextOverlay } from '@shared/types'
import { TURN_RATE } from '@shared/diarize/micTurns'
import { defaultTextStyle } from '@shared/textStyle'

// 10 秒ごとに 8 秒の発話(1〜9, 11〜19, …)。言葉は 0.8 秒ごと
const info: MulticamInfo = {
  anchorSourceId: 'cam',
  sources: [
    { id: 'cam', name: '画面', kind: 'camera', cameraRole: 'screen' },
    { id: 'a', name: 'A', kind: 'mic' }
  ],
  files: [
    { assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: 300 },
    { assetId: 'MA', sourceId: 'a', start: 0, rate: 1, duration: 300 }
  ]
}
const SYL = ['きょう', 'は', 'すごい', 'ボス', 'を', 'たおし', 'に', 'いき', 'ます', 'よ']
const transcript = Array.from({ length: 25 }, (_, k) => {
  const s = k * 10 + 1
  const words = SYL.map((t, i) => ({
    text: t + (i === 0 ? String(k) : ''),
    start: s + i * 0.8,
    end: s + i * 0.8 + 0.7
  }))
  return {
    id: `u${k}`,
    assetId: 'MA',
    speaker: 'A',
    sourceStart: s,
    sourceEnd: s + 8,
    text: words.map((w) => w.text).join(''),
    words,
    overlap: false
  }
})
const activity = new Uint8Array(300 * TURN_RATE)
for (const u of transcript) activity.fill(1, u.sourceStart * TURN_RATE, u.sourceEnd * TURN_RATE)
const asset = (id: string, video: boolean): unknown => ({
  id,
  filePath: `/r/${id}`,
  fileName: id,
  duration: 300,
  width: video ? 1920 : 0,
  height: video ? 1080 : 0,
  hasAudio: true,
  hasVideo: video
})
const project = {
  id: 'p',
  name: 'p',
  aspectRatio: '16:9',
  assets: [asset('C', true), asset('MA', false)],
  clips: [],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: [],
  transcript,
  multicam: info
} as unknown as Project
const look = { style: defaultTextStyle() }

describe('ゲーム実況のショート: 広げた端も発話の切れ目に合わせる', () => {
  it('長さが足りずに広げても、発話の途中から始まらず・途中で終わらない', () => {
    // 101〜109 秒(u10)だけでは 15 秒に届かないので広げる
    const short = buildShortProject(
      { project, info, hype: [], activity, styles: [], speechLook: look },
      { start: 101, end: 109, strength: 10, peaks: 1 },
      0
    )
    const first = short.clips[0]
    const last = short.clips[short.clips.length - 1]
    // u9(91〜99)・u11(111〜119)を丸ごと入れる(秒数だけで広げると 96.5〜113.5 だった)
    expect(first.inPoint).toBeLessThanOrEqual(91 + 1e-6)
    expect(last.outPoint).toBeGreaterThanOrEqual(119 - 1e-6)
    const telops = [...short.textOverlays].sort((a, b) => a.startTime - b.startTime)
    expect(telops[0].startTime).toBeLessThan(0.5)
    expect(telops[telops.length - 1].text.replace(/\n/g, '')).toBe(transcript[11].text)
  })
})

describe('仮編集: 頭・終わりがカットで落ちた発言テロップ', () => {
  it('頭が落ちた枚は捨てずに残った所の頭から出し、文字は残った所の言葉だけにする', () => {
    const plan = planRoughCut(
      project,
      info,
      [{ id: 's', start: 96.5, end: 113.5, lines: [], speech: 0 }],
      [{ sceneId: 's', score: 100, kind: 'highlight', reason: '' }],
      activity,
      {
        targetSec: 0,
        keep: { s: true },
        styles: [],
        speechLook: look,
        kind: 'game',
        policy: 'light'
      }
    )
    const telops = [...plan.telops].sort((a, b) => a.startTime - b.startTime)
    // 96.5 秒から始まる: u9 の「いきますよ」の声が字幕なしで流れていた
    expect(telops[0].startTime).toBeLessThan(0.5)
    expect(telops[0].text.replace(/\n/g, '')).toBe('いきますよ')
    // 113.5 秒で終わる: u11 の切れた言葉(たおしにいきますよ)まで出ていた
    const tail = telops[telops.length - 1].text.replace(/\n/g, '')
    expect(tail.startsWith('きょう11')).toBe(true)
    expect(tail).not.toContain('たおし')
  })
})

describe('SE・CG は人が消した演出テロップに付けない', () => {
  const P = useProjectStore
  const camInfo = {
    anchorSourceId: 'A',
    sources: [{ id: 'A', name: 'A', kind: 'camera' as const }],
    files: [{ assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 }]
  }
  const spans = [{ timeline: 0, start: 0, end: 60 }]
  const cut = {
    main: [{ assetId: 'camA', inPoint: 0, outPoint: 60, speed: 1 }],
    audio: [],
    duration: 60,
    spans
  }
  const fx = (id: string, text: string, at: number): EffectProposal => ({
    id,
    afterLineId: '',
    at,
    kind: 'tsukkomi',
    text,
    confidence: 1,
    reason: ''
  })
  const proposals = [fx('tk1', 'なんでやねん', 10), fx('tk2', 'うそやろ', 30)]
  const chosen = new Set(['tk1', 'tk2'])

  it('消した演出テロップは置かず、置いた後の企画から SE・CG の元を取る(直した文字のまま)', () => {
    P.getState().newProject()
    P.setState({ project: { ...P.getState().project, multicam: camInfo, clips: [] } as Project })
    const first = effectOverlays(proposals, chosen, P.getState().project, camInfo, spans, [])
    P.getState().applyRoughCut(cut, first)
    const placed = P.getState().project.textOverlays
    P.getState().removeTextOverlay(placed.find((t) => t.effectId === 'tk1')!.id)
    const tk2 = P.getState().project.textOverlays.find((t) => t.effectId === 'tk2')!
    P.getState().updateTextOverlay(tk2.id, { text: 'なんでやねん!' })

    // 作り直し: 消したものは提案を選んだままでも置かない
    const again = effectOverlays(proposals, chosen, P.getState().project, camInfo, spans, [])
    expect(again.map((t) => t.effectId)).toEqual(['tk2'])
    P.getState().applyRoughCut(cut, again)
    const live = placedAutoTelops(P.getState().project.textOverlays)
    expect(live.effects.map((t) => [t.effectId, t.text])).toEqual([['tk2', 'なんでやねん!']])
    // CG は直した文字で当てる(消した tk1 の時刻 10 秒には置かない)
    const cg = planCg(live.all, {
      なんでやねん: [{ path: '/cg/x.png', name: 'x', duration: 0, still: true }]
    })
    expect(cg.map((c) => c.startTime)).toEqual([live.effects[0].startTime])
    expect(live.effects[0].startTime).toBeGreaterThan(20)
  })
})

describe('仮編集: 枚の途中の間をカットで詰めて2つに分かれた発言テロップ', () => {
  it('残った所ごとに1枚ずつ出し、聞こえる言葉は全部どこかに出る', () => {
    const plan = planRoughCut(
      project,
      info,
      [
        { id: 's1', start: 0, end: 4, lines: [], speech: 0 },
        { id: 's2', start: 5, end: 10, lines: [], speech: 0 }
      ],
      [
        { sceneId: 's1', score: 100, kind: 'highlight', reason: '' },
        { sceneId: 's2', score: 100, kind: 'highlight', reason: '' }
      ],
      activity,
      {
        targetSec: 0,
        keep: { s1: true, s2: true },
        styles: [],
        speechLook: look,
        kind: 'game',
        policy: 'light'
      }
    )
    const u0 = [...plan.telops]
      .filter((t) => t.utteranceId === 'u0')
      .sort((a, b) => a.startTime - b.startTime)
    expect(u0.map((t) => t.text.replace(/\n/g, ''))).toEqual([
      'きょう0はすごいボス',
      'たおしにいきますよ'
    ])
    // 片方だけ直す・消すことができるよう、鍵は分かれる
    expect(new Set(u0.map((t) => autoTelopKey(t))).size).toBe(2)
  })
})

describe('2つに分かれた枚と、人の修正・消した印(カットを変えて作り直す)', () => {
  const planWith = (s1: [number, number], s2: [number, number]): Omit<TextOverlay, 'id'>[] =>
    planRoughCut(
      project,
      info,
      [
        { id: 's1', start: s1[0], end: s1[1], lines: [], speech: 0 },
        { id: 's2', start: s2[0], end: s2[1], lines: [], speech: 0 }
      ],
      [
        { sceneId: 's1', score: 100, kind: 'highlight', reason: '' },
        { sceneId: 's2', score: 100, kind: 'highlight', reason: '' }
      ],
      activity,
      {
        targetSec: 0,
        keep: { s1: true, s2: true },
        styles: [],
        speechLook: look,
        kind: 'game',
        policy: 'light'
      }
    ).telops
  // u0 の1枚が「きょう0はすごい」「をたおしにいきますよ」に分かれるカットと、分かれないカット
  const split = (): Omit<TextOverlay, 'id'>[] => planWith([0, 3], [4.1, 10])
  const whole = (): Omit<TextOverlay, 'id'>[] => planWith([0, 10], [10, 20])
  const u0 = <T extends { utteranceId?: string }>(xs: readonly T[]): T[] =>
    xs.filter((t) => t.utteranceId === 'u0')
  const ids = (xs: readonly Omit<TextOverlay, 'id'>[]): TextOverlay[] =>
    xs.map((o, i) => ({ ...o, id: `o${i}` }))
  const flat = (xs: readonly { text: string; utteranceId?: string }[]): string =>
    u0(xs)
      .map((t) => t.text.replace(/\s/g, ''))
      .join('|')
  const strip = (o: TextOverlay): TextOverlay => {
    const { autoSource: _drop, ...rest } = o as TextOverlay & { autoSource?: unknown }
    void _drop
    return rest
  }

  it('前の版の修正(範囲なし)は、分かれた枚の両方をまとめて1回だけ出す', () => {
    const old = ids(whole()).map(strip)
    const i = old.findIndex((t) => t.utteranceId === 'u0')
    old[i] = { ...old[i], text: '今日はすごいボスを倒しに行きますよ', edited: true }
    const rem = rememberEditedTelops(old, undefined)
    expect(flat(mergeManualTelops(old, split(), new Set(), rem))).toBe(
      '今日はすごいボスを倒しに行きますよ'
    )
    expect(flat(mergeManualTelops([], split(), new Set(), rem))).toBe(
      '今日はすごいボスを倒しに行きますよ'
    )
  })

  it('分かれた枚の片方を消してカットを戻すと、消した言葉だけを出さない', () => {
    const tl = ids(split())
    const [p1, p2] = u0(tl)
    const after = (gone: TextOverlay): string => {
      const rest = tl.filter((t) => t !== gone)
      return flat(
        mergeManualTelops(
          rest,
          whole(),
          new Set([autoTelopKey(gone)!]),
          rememberEditedTelops(rest, undefined)
        )
      )
    }
    // 2枚目を消した: 1枚目の言葉は残る(分けて消えたのは 2枚目の言葉だけ。ボスは 2つのカットの間で聞こえる)
    expect(after(p2)).toBe('きょう0はすごいボス')
    // 1枚目を消した: 消した言葉は戻らない
    expect(after(p1)).toBe('ボスをたおしにいきますよ')
  })

  it('1枚目を直して2枚目を消し、カットを戻しても、直した文字は残る', () => {
    const tl = ids(split())
    const [p1, p2] = u0(tl)
    const edited = tl.map((t) => (t === p1 ? { ...t, text: '今日は凄い', edited: true } : t))
    const rest = edited.filter((t) => t.id !== p2.id)
    const merged = mergeManualTelops(
      rest,
      whole(),
      new Set([autoTelopKey(p2)!]),
      rememberEditedTelops(rest, undefined)
    )
    expect(flat(merged)).toBe('今日は凄い|ボス')
  })
})

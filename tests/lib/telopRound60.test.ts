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
import { utteranceToTelopChunks } from '@shared/telop/fromTranscript'
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
const flat = (t: { text: string }): string => t.text.replace(/\s/g, '')

const kanji = (s: string): string[] => [...s].filter((c) => /\p{Script=Han}/u.test(c))

/** 枚の頭(素材の秒)。タイムライン = offset + 素材の秒 */
const srcStart = (t: Auto): number => t.startTime - t.autoSource!.offset!

/**
 * 第60回: 長さ 0 の言葉の文字を並べるのに次の言葉の時刻をずらさない(長さのある言葉の時刻は動かさない)。
 * ずらすと、ずれが積もって次の言葉の枚が声より遅れ、カットの後ろへ聞こえない言葉が出ていた
 */
describe('長さ 0 の言葉が続いても、次の言葉の時刻は動かさない', () => {
  it('長さ 0 の言葉が 20 個続いても、次の言葉の枚は声から 0.15 秒以内に出る', () => {
    const words: W[] = []
    for (let i = 0; i < 20; i++)
      words.push({
        text: String.fromCodePoint(0x4e00 + 2 * i) + String.fromCodePoint(0x4e01 + 2 * i),
        start: 1.0,
        end: 1.0
      })
    words.push(
      { text: '猫犬', start: 1.0, end: 1.6 },
      { text: '鳥', start: 1.6, end: 2.0 },
      { text: '馬', start: 3.0, end: 3.5 }
    )
    for (const lc of [3, 4, 6]) {
      const t = plan([words], [{ start: 0, end: 5 }], lc).find((x) => flat(x).startsWith('猫'))
      if (!t) continue
      // 直す前は次の言葉をずらし、「猫犬」の枚が 1.160 秒に出ていた
      expect(srcStart(t) - 1.0).toBeLessThan(0.15)
    }
  })

  it('カットの直前の長さ 0 の言葉の文字を、カットの後ろへ並べない(聞こえない言葉が出ない)', () => {
    const words: W[] = [
      { text: '丁丂', start: 0.5, end: 1.2 },
      { text: 'あのー、', start: 1.45, end: 1.45 },
      { text: 'えっと、', start: 1.5, end: 1.5 },
      { text: '七丄、', start: 1.5, end: 1.5 },
      { text: 'まあ、', start: 1.52, end: 1.52 },
      { text: '丅丆', start: 1.62, end: 1.9 },
      { text: '丏丐', start: 1.9, end: 2.3 }
    ]
    const p = plan(
      [words],
      [
        { start: 0.4, end: 1.25 },
        { start: 1.51, end: 3.0 }
      ],
      8
    )
    // 直す前は、ずらした「七丄」がカットの後ろの区間(1.51 秒〜)に入り「七丄丅丆丏丐」と出ていた
    expect(p.map(flat).join(' | ')).toBe('丁丂 | 丅丆丏丐')
  })

  it('切り分けた枚を消したら、長さ 0 の言葉の後ろの言葉も戻らない', () => {
    const words: W[] = [
      { text: '今日は', start: 1.0, end: 1.6 },
      { text: '享亮亱', start: 1.6, end: 1.6 },
      { text: '人', start: 1.6, end: 1.9 },
      { text: '配信', start: 2.0, end: 2.5 },
      { text: 'します', start: 2.5, end: 3.0 }
    ]
    const sc = [{ start: 0, end: 4 }]
    for (const b of [4, 5, 7]) {
      const pA = ids(plan([words], sc, 3))
      const tlA = pA.map((t) => (flat(t) === '配信します' ? { ...t, text: 'E0', edited: true } : t))
      const mB = ids(mergeManualTelops(tlA, plan([words], sc, b), new Set()))
      for (const carved of mB.filter((t) => !t.edited)) {
        const tlB = mB.filter((t) => t !== carved)
        const out = mergeManualTelops(tlB, plan([words], sc, b), new Set([autoTelopKey(carved)!]))
        const want = mB.filter((t) => t !== carved).map((t) => (t.edited ? 'E0' : flat(t)))
        expect(out.map((t) => (t.edited ? 'E0' : flat(t)))).toEqual(want)
      }
    }
  })
})

describe('長さ 0 の言葉の文字が前後の言葉の間に入りきらない', () => {
  const words: W[] = [
    { text: '今日は', start: 1.0, end: 1.6 },
    { text: '一二三四五六', start: 1.6, end: 1.6 },
    { text: '七八九十', start: 1.6, end: 1.6 },
    { text: '配信', start: 1.6, end: 1.62 },
    { text: '丁丂', start: 1.62, end: 1.62 },
    { text: '书乩', start: 1.62, end: 1.64 },
    { text: 'します', start: 1.64, end: 2.2 }
  ]
  it('文字の時刻は増える順で、どの枚の範囲もほかの枚の文字の時刻を含まない', () => {
    for (const lc of [2, 3, 4, 5, 6, 8]) {
      const u = {
        id: 'u0',
        text: words.map((w) => w.text).join(''),
        words,
        sourceStart: 1,
        sourceEnd: 2.2
      }
      const chunks = utteranceToTelopChunks(u as never, { maxLineChars: lc })
      const times = chunks.flatMap((c) => c.times ?? [])
      for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
      chunks.forEach((c, k) => {
        const others = chunks.filter((_, j) => j !== k).flatMap((x) => x.times ?? [])
        for (const t of others)
          expect(t < c.range![0] || t > c.range![1], `${lc} ${c.text} ${t}`).toBe(true)
      })
    }
  })
})

describe('切り分けた枚を直したとき、修正を消したかの判定', () => {
  it('「亽什仃」の「仃」を消した後に直した「亽什」は、作り直しても消えない', () => {
    // 切り分けた枚の範囲は隣の消した言葉の手前(文字の真ん中どうしの間)まで伸びる。範囲の重なりで
    // 決めると、直した「亽什」の範囲が「仃」を消した範囲と半分以上重なり、修正が消えていた
    const words: W[] = [
      { text: '今日は', start: 36.0, end: 36.9 },
      { text: 'ね', start: 37.177, end: 37.177 },
      { text: '亽什', start: 37.177, end: 37.177 },
      { text: '仃、', start: 37.366, end: 40.252 },
      { text: '仆仉', start: 40.4, end: 41.0 }
    ]
    const sc = [{ start: 35, end: 42 }]
    const a = ids(plan([words], sc, 2))
    const shin = a.find((t) => flat(t) === '仃')
    expect(shin, a.map(flat).join('|')).toBeDefined()
    const dis = new Set([autoTelopKey(shin!)!])
    const b = ids(
      mergeManualTelops(
        a.filter((t) => t !== shin),
        plan([words], sc, 4),
        dis
      )
    )
    const carved = b.find((t) => flat(t) === '亽什')
    expect(carved, b.map(flat).join('|')).toBeDefined()
    const tl = b.map((t) => (t === carved ? { ...t, text: 'E!', edited: true } : t))
    const out = mergeManualTelops(
      tl,
      plan([words], sc, 4),
      dis,
      rememberEditedTelops(tl, undefined)
    )
    expect(out.filter((t) => t.text === 'E!')).toHaveLength(1)
    expect(out.map(flat).join('')).not.toContain('仃')
  })
})

describe('頭・終わりをカットで落とした枚の文字の選び方', () => {
  it('言葉の時刻が重なっていても、前の枚の文字を選ばない(同じ言葉が2枚に出ない)', () => {
    // 音声認識の言葉の時刻は重なることがある(「今日は」の終わりより「配信」の頭が早い)。時刻の窓で元の
    // 文字を選ぶと、前の枚の「は」が窓に入り、2枚に出る
    const words: W[] = [
      { text: '今日は', start: 1.0, end: 1.9 },
      { text: '配信', start: 1.5, end: 2.2 },
      { text: 'します', start: 2.2, end: 3.0 }
    ]
    for (const lc of [3, 4])
      for (const end of [2.6, 2.8]) {
        const p = plan([words], [{ start: 0, end }], lc)
        expect(kanji(p.map(flat).join('')).filter((c) => c === '日')).toHaveLength(1)
        expect([...p.map(flat).join('')].filter((c) => c === 'は')).toHaveLength(1)
      }
  })
})

describe('直してから消した修正', () => {
  it('作り直しで何枚目かが変わった修正の枚を消すと、覚えておいた前の番号の修正も出さない', () => {
    const words: W[] = [
      { text: '今日は、', start: 1.0, end: 1.6 },
      { text: 'えー、', start: 1.6, end: 2.4 },
      { text: '配信', start: 2.5, end: 3.0 },
      { text: 'します', start: 3.0, end: 3.5 },
      { text: '猫犬', start: 3.5, end: 4.0 }
    ]
    const sc = [{ start: 0, end: 6 }]
    for (const [a, b] of [
      [3, 14],
      [5, 14],
      [7, 14]
    ]) {
      const p = ids(plan([words], sc, a))
      for (const S of p) {
        const tl = p.map((t) => (t === S ? { ...t, text: 'E!', edited: true } : t))
        const rem = rememberEditedTelops(tl, undefined)
        const m1 = ids(mergeManualTelops(tl, plan([words], sc, b), new Set(), rem))
        const E = m1.find((t) => t.edited)!
        expect(E).toBeDefined()
        // 消した後、覚えておいた修正は前の番号の鍵のまま(作り直しの前に覚え直していない)
        const out = mergeManualTelops(
          m1.filter((t) => t !== E),
          plan([words], sc, b),
          new Set([autoTelopKey(E)!]),
          rem
        )
        expect(
          out.filter((t) => t.edited),
          `${a}→${b} ${flat(S)}`
        ).toEqual([])
      }
    }
  })
})

describe('長さ 0 の言葉の直前のカット', () => {
  it('言葉の時刻の直前で切ると、その言葉の文字はカットの前に並べない(聞こえない言葉が出ない)', () => {
    // 次の言葉が 0.02 秒後に続く長さ 0 の言葉を、前の言葉との間まで広げて並べると、言葉の時刻の直前の
    // カット(43.99 秒)の前に「亴」が入り、聞こえない言葉が出ていた
    const words: W[] = [
      { text: '亟亢', start: 38.7575, end: 39.1229 },
      { text: '亥亨享、', start: 39.2719, end: 39.8043 },
      { text: 'あと', start: 39.8696, end: 40.187 },
      { text: 'えーと、', start: 40.2559, end: 41.0303 },
      { text: 'あのー、', start: 41.1884, end: 41.7904 },
      { text: 'あのー、', start: 41.9172, end: 42.6025 },
      { text: '亮亱、', start: 42.6227, end: 43.2419 },
      { text: 'えーと、', start: 43.3452, end: 43.9722 },
      { text: '亴亷人', start: 43.9938, end: 43.9938 },
      { text: '亽什仃', start: 44.0138, end: 44.8617 },
      { text: 'あのー、', start: 44.9963, end: 46.0767 },
      { text: '仆仉仌', start: 46.173, end: 48.9965 }
    ]
    for (const lc of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const p = plan([words], [{ start: 38, end: 43.99 }], lc)
      expect(p.map(flat).join('|')).not.toMatch(/[亴亷人]/)
    }
  })
})

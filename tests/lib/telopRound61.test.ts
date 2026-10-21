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
const show = (ts: readonly { text: string; edited?: boolean }[]): string =>
  ts.map((t) => (t.edited ? `[${t.text}]` : flat(t))).join(' | ')

/**
 * 第61回: 辞書で直した文字は、直す前の言葉が話された範囲全体を受け持つ。枚の範囲を前後の文字との
 * 真ん中まで縮めるとき、辞書で短くした言葉(「あいうえお」→「X」)の枚の範囲が「X」の時刻(言葉の
 * 真ん中)から測って縮められ、元の言葉の頭の「あ」が範囲から外れていた
 */
describe('辞書で短くした言葉の枚の範囲', () => {
  const dict = [{ from: 'あいうえお', to: 'X' }]
  const words: W[] = [
    { text: '今日は', start: 0.4, end: 1.0 },
    { text: 'あいうえお', start: 1.0, end: 1.5 },
    { text: '配信します', start: 2.0, end: 2.5 }
  ]
  const sc = [{ start: 0, end: 4 }]

  it('直した枚は、辞書を外して作り直しても元の言葉をみな受け持つ', () => {
    const a = ids(plan([words], sc, 3, dict))
    const x = a.find((t) => flat(t) === 'X')
    expect(x, show(a)).toBeDefined()
    const tl = a.map((t) => (t === x ? { ...t, text: 'E', edited: true } : t))
    const out = mergeManualTelops(
      tl,
      plan([words], sc, 3),
      new Set(),
      rememberEditedTelops(tl, undefined)
    )
    expect(show(out)).toBe('今日は | [E] | 配信します')
  })

  it('消した枚は、辞書を外して作り直しても元の言葉の文字を出さない', () => {
    const w2 = words.map((w) => (w.text === '配信します' ? { ...w, start: 1.6 } : w))
    const a = ids(plan([w2], sc, 3, dict))
    const x = a.find((t) => flat(t) === 'X')
    expect(x, show(a)).toBeDefined()
    const out = mergeManualTelops(
      a.filter((t) => t !== x),
      plan([w2], sc, 3),
      new Set([autoTelopKey(x!)!])
    )
    expect(show(out)).toBe('今日は | 配信します')
  })
})

describe('辞書で短くした言葉の枚(1行の長さ・言葉の時刻を変えて)', () => {
  const dict = [{ from: 'あいうえお', to: 'X' }]
  it('直した・消した枚の元の言葉の文字は、辞書を外して作り直しても出ない', () => {
    let tried = 0
    for (const next of [1.5, 1.6, 2.0])
      for (const lc of [3, 4, 5, 6, 8]) {
        const words: W[] = [
          { text: '今日は', start: 0.4, end: 1.0 },
          { text: 'あいうえお', start: 1.0, end: 1.5 },
          { text: '配信します', start: next, end: next + 0.5 }
        ]
        const sc = [{ start: 0, end: 4 }]
        const a = ids(plan([words], sc, lc, dict))
        const x = a.find((t) => flat(t).includes('X'))
        const tag = `${next} ${lc} ${show(a)}`
        // 枚の区切りが言葉の途中に入って辞書が当たらない形(「今日はあいうえ | お配信します」)は除く
        if (!x) continue
        tried++
        const tl = a.map((t) => (t === x ? { ...t, text: 'E', edited: true } : t))
        const ed = mergeManualTelops(
          tl,
          plan([words], sc, lc),
          new Set(),
          rememberEditedTelops(tl, undefined)
        )
        expect(
          ed.filter((t) => t.edited).map((t) => t.text),
          tag
        ).toEqual(['E'])
        expect(show(ed.filter((t) => !t.edited)), tag).not.toMatch(/[あいうえお]/)
        const del = mergeManualTelops(
          a.filter((t) => t !== x),
          plan([words], sc, lc),
          new Set([autoTelopKey(x)!])
        )
        expect(show(del), tag).not.toMatch(/[あいうえお]/)
        // ほかの枚の言葉は残る
        expect(del.map(flat), tag).toEqual(a.filter((t) => t !== x).map(flat))
      }
    expect(tried).toBeGreaterThanOrEqual(12)
  })
})

/**
 * 第61回: 辞書で長くした言葉が2枚に分かれたとき、隣の枚の文字は同じ元の言葉から作った文字でも
 * 範囲に入れない(前の枚を消すと後ろの枚の頭の「チ」まで消え、後ろの枚を直すと前の枚の「ブ」が消えていた)
 */
describe('辞書で長くした言葉が枚に分かれたときの、隣の枚の文字', () => {
  const dict = [{ from: 'ゆう', to: 'ユーチューブチャンネル登録' }]
  const words: W[] = [
    { text: '今日は', start: 0.4, end: 1.0 },
    { text: 'ゆう', start: 1.0, end: 1.0 },
    { text: '配信します', start: 1.6, end: 2.5 }
  ]
  const sc = [{ start: 0, end: 4 }]

  it('前の枚を消しても、後ろの枚の文字はそのまま出る', () => {
    const a = ids(plan([words], sc, 6, dict))
    expect(show(a)).toBe('今日はユーチューブ | チャンネル登録配信します')
    const out = mergeManualTelops(
      a.slice(1),
      plan([words], sc, 6, dict),
      new Set([autoTelopKey(a[0])!])
    )
    expect(show(out)).toBe('チャンネル登録配信します')
  })

  it('後ろの枚を直しても、前の枚の文字はそのまま出る', () => {
    const a = ids(plan([words], sc, 6, dict))
    const tl = a.map((t, i) => (i === 1 ? { ...t, text: 'E', edited: true } : t))
    const out = mergeManualTelops(
      tl,
      plan([words], sc, 6, dict),
      new Set(),
      rememberEditedTelops(tl, undefined)
    )
    expect(show(out)).toBe('今日はユーチューブ | [E]')
  })

  it('どの枚の範囲も、ほかの枚の文字の時刻を含まない', () => {
    for (const lc of [2, 3, 4, 5, 6, 8]) {
      const u = {
        id: 'u0',
        text: words.map((w) => w.text).join(''),
        words,
        sourceStart: 0.4,
        sourceEnd: 2.5
      }
      const chunks = utteranceToTelopChunks(u as never, { maxLineChars: lc, dictionary: dict })
      chunks.forEach((c, k) => {
        const others = chunks.filter((_, j) => j !== k).flatMap((x) => x.times ?? [])
        // 消した印の鍵は範囲を 1/1000 秒に丸めて覚えるので、丸めた範囲でも
        const [lo, hi] = c.range!.map((x) => Number(x.toFixed(3)))
        for (const t of others) {
          expect(t < c.range![0] || t > c.range![1], `${lc} ${c.text} ${t}`).toBe(true)
          expect(t < lo - 1e-9 || t > hi + 1e-9, `${lc} ${c.text} ${t} 丸め`).toBe(true)
        }
        for (const t of c.times ?? []) expect(t >= lo && t <= hi, `${lc} ${c.text} ${t}`).toBe(true)
      })
    }
  })

  it('長さ 0 の言葉の時刻・辞書の言葉の長さを変えても、丸めた範囲がほかの枚の文字の時刻を含まない', () => {
    const to = 'ユーチューブチャンネル登録の皆さんこんにちは'
    for (let q = 0; q < 40; q++) {
      const t0 = 1 + q * 0.00037
      const ws: W[] = [
        { text: '今日は', start: 0.4, end: t0 },
        { text: 'ゆう', start: t0, end: t0 },
        { text: '配信します', start: t0 + 0.6, end: t0 + 1.5 }
      ]
      const d = [{ from: 'ゆう', to: to.slice(0, 5 + (q % 17)) }]
      for (const lc of [2, 3, 4, 5, 6, 8]) {
        const u = {
          id: 'u0',
          text: '今日はゆう配信します',
          words: ws,
          sourceStart: 0.4,
          sourceEnd: 3
        }
        const chunks = utteranceToTelopChunks(u as never, { maxLineChars: lc, dictionary: d })
        chunks.forEach((c, k) => {
          const [lo, hi] = c.range!.map((x) => Number(x.toFixed(3)))
          for (const t of chunks.filter((_, j) => j !== k).flatMap((x) => x.times ?? []))
            expect(t < lo - 1e-9 || t > hi + 1e-9, `${q} ${lc} ${c.text} ${t}`).toBe(true)
        })
      }
    }
  })

  it('どの1行の長さでも、1枚を消す・直すとき、ほかの枚の文字はそのまま', () => {
    for (const lc of [3, 4, 5, 6, 7, 8]) {
      const a = ids(plan([words], sc, lc, dict))
      for (const S of a) {
        const rest = a.filter((t) => t !== S).map(flat)
        const del = mergeManualTelops(
          a.filter((t) => t !== S),
          plan([words], sc, lc, dict),
          new Set([autoTelopKey(S)!])
        )
        expect(del.map(flat), `${lc} 消す ${flat(S)}`).toEqual(rest)
        const tl = a.map((t) => (t === S ? { ...t, text: 'E', edited: true } : t))
        const ed = mergeManualTelops(
          tl,
          plan([words], sc, lc, dict),
          new Set(),
          rememberEditedTelops(tl, undefined)
        )
        expect(show(ed), `${lc} 直す ${flat(S)}`).toBe(show(tl))
      }
    }
  })

  // カットで頭・終わりを落とした枚は、残った文字で範囲を測り直す。そのとき元の文字の並びしか見ないと、
  // 辞書で長くして分けた隣の枚の文字(「ブ」)まで範囲に入り、落とした枚を消すと隣の枚の最後の文字が消えた
  it('カットで頭・終わりを落としても、1枚を消す・直すとき、ほかの枚の文字はそのまま', () => {
    let tried = 0
    for (const end of [1.2, 1.5, 1.7, 1.9, 2.0, 2.2, 2.4])
      for (const head of [0, 0.5, 0.95, 1.005, 1.01])
        for (const lc of [3, 4, 5, 6, 7, 8]) {
          const cut = [{ start: head, end }]
          const a = ids(plan([words], cut, lc, dict))
          for (const S of a) {
            tried++
            const tag = `${end} ${head} ${lc} ${flat(S)} :: ${show(a)}`
            const rest = a.filter((t) => t !== S)
            const del = mergeManualTelops(
              rest,
              plan([words], cut, lc, dict),
              new Set([autoTelopKey(S)!])
            )
            expect(show(del), `消す ${tag}`).toBe(show(rest))
            const tl = a.map((t) => (t === S ? { ...t, text: 'E', edited: true } : t))
            const ed = mergeManualTelops(
              tl,
              plan([words], cut, lc, dict),
              new Set(),
              rememberEditedTelops(tl, undefined)
            )
            expect(show(ed), `直す ${tag}`).toBe(show(tl))
          }
        }
    expect(tried).toBeGreaterThan(200)
  })
})

/**
 * 第61回: 辞書で長くした言葉が3枚以上に分かれると、真ん中の枚の時間が言葉の長さ(長さ 0 の言葉なら
 * 0.01 秒ほど)しかなく、仮編集で捨てられてその文字が出ない。これは既知の制限として受け入れる
 * (第62回の枚の頭をずらす直し・第63回の隣の枚にまとめる直しは、どちらも退行を生んだのでやめた)。
 * 前後の声のある言葉は出て、どの枚も 0.3 秒以上・順は崩れず、1行の長さが足りれば全部出る
 */
describe('辞書で長くした言葉が3枚に分かれたとき', () => {
  const dict = [{ from: 'ゆう', to: 'ユーチューブチャンネル登録' }]
  const words: W[] = [
    { text: '今日は', start: 0.4, end: 1.0 },
    { text: 'ゆう', start: 1.0, end: 1.0 },
    { text: '配信します', start: 1.6, end: 2.5 }
  ]
  it('声のある言葉は出て、順が崩れない', () => {
    const full = '今日はユーチューブチャンネル登録配信します'
    for (const lc of [3, 4, 5, 6, 7, 8]) {
      const a = plan([words], [{ start: 0, end: 4 }], lc, dict)
      const got = a.map(flat).join('')
      const tag = `${lc} ${show(a)}`
      expect(got, tag).toMatch(/^今日はユー.*配信します$/)
      // 出した文字は全部の文字の並びの一部(同じ文字を2回出さない・順が崩れない)
      let k = 0
      for (const c of full) if (k < got.length && got[k] === c) k++
      expect(k, tag).toBe(got.length)
      // 1行 5 文字以上なら、真ん中の枚も 0.3 秒以上あって全部出る
      if (lc >= 5) expect(got, tag).toBe(full)
      for (let i = 0; i < a.length; i++) {
        expect(a[i].endTime - a[i].startTime, tag).toBeGreaterThanOrEqual(0.3)
        if (i > 0) expect(a[i].startTime, tag).toBeGreaterThanOrEqual(a[i - 1].endTime - 1e-6)
      }
    }
  })
})

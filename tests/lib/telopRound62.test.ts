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
import { telopsFromTranscript } from '../../src/renderer/src/lib/transcriptTimeline'
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
  return planCut(utterances, scenes, lineChars, dictionary).telops as Auto[]
}
function planCut(
  utterances: W[][],
  scenes: { start: number; end: number }[],
  lineChars: number,
  dictionary: { from: string; to: string }[] = []
): ReturnType<typeof planRoughCut> {
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
  )
}
const ids = (ts: readonly Auto[]): TextOverlay[] =>
  ts.map((t, i) => ({ ...t, id: `t${i}` })) as TextOverlay[]
const flat = (t: { text: string }): string => t.text.replace(/\s/g, '')
const show = (
  ts: readonly { text: string; edited?: boolean; startTime?: number; endTime?: number }[]
): string =>
  ts
    .map(
      (t) =>
        `${t.edited ? `[${t.text}]` : flat(t)}@${t.startTime?.toFixed(3)}-${t.endTime?.toFixed(3)}`
    )
    .join(' | ')
const sc04 = [{ start: 0, end: 4 }]
const HYPER = [{ from: 'はい', to: 'ハイパーメディアクリエイター' }]
const YT = [{ from: 'ゆう', to: 'ユーチューブチャンネル登録' }]
const ytFull = 'ユーチューブチャンネル登録'

/** 枚の頭が時刻順で、同じ発言の枚が重ならず、どの枚も 0.3 秒以上 */
function expectOrdered(ts: readonly Auto[], tag: string): void {
  for (let i = 0; i < ts.length; i++) {
    expect(ts[i].endTime - ts[i].startTime, `${tag} ${show(ts)}`).toBeGreaterThanOrEqual(0.3)
    if (i > 0) {
      expect(ts[i].startTime, `${tag} ${show(ts)}`).toBeGreaterThanOrEqual(ts[i - 1].startTime)
      expect(ts[i].startTime, `${tag} ${show(ts)}`).toBeGreaterThanOrEqual(ts[i - 1].endTime - 1e-6)
    }
  }
}

/** 出した文字が、全部の文字の並びの一部で順も同じ(同じ文字を2回出さない・順が崩れない) */
function expectSubsequence(ts: readonly { text: string }[], full: string, tag: string): void {
  const got = ts.map(flat).join('')
  let k = 0
  for (const c of full) if (k < got.length && got[k] === c) k++
  expect(k, `${tag} ${got} ⊄ ${full}`).toBe(got.length)
}

/**
 * 0.3 秒に満たない枚は出さない(第61回と同じ)。第62回は枚の頭をずらして間を作り(spaceSheets)、第63回は
 * 短い枚を隣の枚にまとめたが、どちらも退行を生んだのでやめた。辞書で短い言葉を極端に長くすると、その言葉の
 * 一部の枚が出ないことがある(既知の制限)。それでも、声のある言葉・枚の順・時刻は崩れない
 * (第62回の監査 1: 枚の時刻をずらすと、声のある言葉の枚まで 0.3 秒未満に均されて捨てられていた)
 */
describe('辞書で極端に長くした言葉(0.3 秒未満の枚は出さない)', () => {
  it('します|はい|します(1行4文字)', () => {
    const words: W[] = [
      { text: 'します', start: 0.31, end: 0.54 },
      { text: 'はい', start: 0.54, end: 1.0 },
      { text: 'します', start: 1.0, end: 1.08 }
    ]
    const a = plan([words], sc04, 4, HYPER)
    expectSubsequence(a, 'しますハイパーメディアクリエイターします', show(a))
    expect(a.map(flat).join(''), show(a)).toMatch(/^します.*します$/)
    expectOrdered(a, '')
    // 声に合わせたまま(頭は声の少し前から、声の後へずらさない)
    expect(a[0].startTime, show(a)).toBeLessThanOrEqual(0.31)
  })

  it('ゆう|ゆう(長さ0)|あ|ゆう(長さ0)(1行2文字)', () => {
    const words: W[] = [
      { text: 'ゆう', start: 0.92, end: 1.36 },
      { text: 'ゆう', start: 1.36, end: 1.36 },
      { text: 'あ', start: 1.36, end: 1.77 },
      { text: 'ゆう', start: 1.77, end: 1.77 }
    ]
    const a = plan([words], sc04, 2, YT)
    expectSubsequence(a, `${ytFull}${ytFull}あ${ytFull}`, show(a))
    expect(a.map(flat).join(''), show(a)).toContain('あ')
    expectOrdered(a, '')
  })
})

/** 仮編集を使わない文字起こしのテロップも、0.3 秒に満たない枚は出さない(仮編集と同じく、まとめない) */
describe('文字起こしのテロップ(仮編集なし)', () => {
  it('辞書で長くして分けた言葉の前後の言葉は出て、順が崩れない', () => {
    const words: W[] = [
      { text: '今日は', start: 0.4, end: 1.0 },
      { text: 'ゆう', start: 1.0, end: 1.0 },
      { text: '配信します', start: 1.6, end: 2.5 }
    ]
    for (const lc of [3, 4, 5, 6]) {
      const project = {
        aspectRatio: '16:9',
        assets: [{ id: 'A', filePath: '/x/A.mp4', duration: 600 }],
        clips: [{ id: 'c', assetId: 'A', inPoint: 0, outPoint: 10, speed: 1 }],
        audioTracks: [],
        videoOverlayTracks: [],
        transcript: [
          {
            id: 'u0',
            assetId: 'A',
            sourceStart: 0.4,
            sourceEnd: 2.5,
            text: '今日はゆう配信します',
            words,
            overlap: false
          }
        ]
      } as unknown as Project
      const out = telopsFromTranscript(project, [], YT, { lineChars: lc, minSec: 1 })
      const all = out.map(flat).join('')
      expectSubsequence(out, `今日は${ytFull}配信します`, `${lc} ${show(out)}`)
      expect(all, `${lc} ${show(out)}`).toMatch(/^今日は.*配信します$/)
      // 1行 5 文字以上なら、どの枚も 0.3 秒以上あって全部出る
      if (lc >= 5) expect(all, `${lc} ${show(out)}`).toBe(`今日は${ytFull}配信します`)
      expectOrdered(out as Auto[], `${lc}`)
      // 1行の文字数を超えない
      for (const t of out)
        for (const line of t.text.split('\n'))
          expect([...line].length, `${lc} ${show(out)}`).toBeLessThanOrEqual(lc)
    }
  })
})

/**
 * 第62回の監査 2: 声の無い枚の頭の上限が無く、枚の頭の順が崩れて重なった
 */
describe('枚の頭が時刻順で重ならない', () => {
  it('はい|今日は(長さ0)×2|あ|えーと(1行2文字)', () => {
    const words: W[] = [
      { text: 'はい', start: 0.94, end: 1.34 },
      { text: '今日は', start: 1.34, end: 1.34 },
      { text: '今日は', start: 1.34, end: 1.34 },
      { text: 'あ', start: 1.34, end: 1.81 },
      { text: 'えーと', start: 1.81, end: 2.01 }
    ]
    const a = plan([words], sc04, 2, HYPER)
    expectSubsequence(a, 'ハイパーメディアクリエイター今日は今日はあ', show(a))
    expect(a.map(flat).join(''), show(a)).toMatch(/あ$/)
    expectOrdered(a, '')
  })
})

/**
 * 第63回の監査 2: 短い枚を離れた前の枚にまとめると、声から 2 秒以上ずれて出た(「今日は配信」0.40〜3.20)。
 * 短い枚は出さないので、枚は声に合わせたまま
 */
describe('短い枚が離れた枚にまとめられない', () => {
  it('今日は|配信(カットの手前で 0.15 秒)|です(カットの外)(1行3文字)', () => {
    const words: W[] = [
      { text: '今日は', start: 0.4, end: 1.0 },
      { text: '配信', start: 3.0, end: 3.15 },
      { text: 'です', start: 3.3, end: 3.8 }
    ]
    const a = plan(
      [words],
      [
        { start: 0, end: 3.2 },
        { start: 5, end: 8 }
      ],
      3
    )
    expect(a.map(flat).join(''), show(a)).not.toMatch(/今日は配/)
    for (const t of a) {
      if (flat(t).includes('今日は')) expect(t.startTime, show(a)).toBeCloseTo(0.4, 1)
      if (/[配信]/.test(flat(t))) expect(t.startTime, show(a)).toBeGreaterThan(2.5)
    }
    expectOrdered(a, '')
  })
})

/**
 * 第62回の監査 3: カットで落とした言葉の断片が、枚の頭をずらしたせいでカットの後ろに出た
 */
describe('カットの外の文字が出ない', () => {
  it('ゆう|ね|ゆう(長さ0、カットの中)', () => {
    const words: W[] = [
      { text: 'ゆう', start: 0.69, end: 1.2 },
      { text: 'ね', start: 1.56, end: 2.25 },
      { text: 'ゆう', start: 2.62, end: 2.62 }
    ]
    const a = plan(
      [words],
      [
        { start: 0, end: 2.37 },
        { start: 2.87, end: 7 }
      ],
      4,
      YT
    )
    expect(a.map(flat).join(''), show(a)).toBe(`${ytFull}ね`)
    for (const t of a) expect(t.endTime, show(a)).toBeLessThanOrEqual(2.37 + 1e-6)
    expectOrdered(a, '')
  })

  // 長さ 0 の言葉の文字は言葉の時刻の後ろへ 0.0015 秒おきに並べるので、言葉の時刻がカットの頭のすぐ前だと、
  // 並べた文字の一部がカットの中に入る。言葉の時刻がカットの外なら出さない
  it('長さ 0 の言葉の時刻がカットの頭のすぐ前(辞書で長くした文字がカットの中へはみ出す)', () => {
    for (const t0 of [2.17, 2.18, 2.183, 2.185, 2.188])
      for (const lc of [4, 6, 8]) {
        const a = plan(
          [
            [
              { text: '今日は', start: 0.4, end: 1.0 },
              { text: 'です', start: 1.1, end: 1.5 },
              { text: 'ゆう', start: t0, end: t0 }
            ],
            [{ text: '配信', start: 3.0, end: 3.4 }]
          ],
          [
            { start: 0, end: 1.62 },
            { start: 2.19, end: 4 }
          ],
          lc,
          YT
        )
        expect(a.map(flat).join(''), `${t0} ${lc} ${show(a)}`).toBe('今日はです配信')
      }
  })
})

/**
 * 第62回の監査 4: 枚の範囲を、隣の piece の文字の元の文字の真ん中で縮めていたので、辞書で長くした言葉の
 * 最後の文字(「録」)が隣の枚の範囲に入り、隣の枚を消すと「録」まで消えた
 */
describe('隣の piece の辞書で長くした文字を、枚の範囲に入れない', () => {
  const words: W[] = [
    { text: 'です', start: 0.62, end: 1.12 },
    { text: 'ゆう', start: 1.46, end: 1.46 },
    { text: 'そう', start: 1.46, end: 1.46 }
  ]
  // 枚の分け方は1行の長さで変わる(0.3 秒に満たない真ん中の枚は出ない)。「そう」の入った枚を消す・直しても、
  // ほかの枚はそのまま
  it('「そう」の枚を消す・直しても、ほかの枚はそのまま', () => {
    for (const lc of [3, 4, 5, 6]) {
      const a = ids(plan([words], sc04, lc, YT))
      const s = a.find((t) => flat(t).endsWith('そう'))
      expect(s, `${lc} ${show(a)}`).toBeDefined()
      expectOrdered(a as Auto[], `${lc}`)
      const del = mergeManualTelops(
        a.filter((t) => t !== s),
        plan([words], sc04, lc, YT),
        new Set([autoTelopKey(s!)!])
      )
      expect(show(del), `${lc} 消す`).toBe(show(a.filter((t) => t !== s)))
      const tl = a.map((t) => (t === s ? { ...t, text: 'E', edited: true } : t))
      const ed = mergeManualTelops(
        tl,
        plan([words], sc04, lc, YT),
        new Set(),
        rememberEditedTelops(tl, undefined)
      )
      expect(ed.map((t) => (t.edited ? `[${t.text}]` : flat(t))).join(' | '), `${lc} 直す`).toBe(
        tl.map((t) => (t.edited ? `[${t.text}]` : flat(t))).join(' | ')
      )
    }
  })

  it('「そう」の枚の終わりがカットで落ちても、「そう」を消してほかの枚はそのまま', () => {
    const cut = [
      { start: 0, end: 2.0 },
      { start: 3, end: 5 }
    ]
    const a = ids(plan([words], cut, 3, YT))
    const s = a.find((t) => flat(t) === 'そう')
    expect(s, show(a)).toBeDefined()
    expect(s!.endTime, show(a)).toBeLessThanOrEqual(2.0 + 1e-6)
    const out = mergeManualTelops(
      a.filter((t) => t !== s),
      plan([words], cut, 3, YT),
      new Set([autoTelopKey(s!)!])
    )
    expect(show(out)).toBe(show(a.filter((t) => t !== s)))
  })

  it('どの1行の長さでも、枚の範囲がほかの枚の文字の時刻を含まない', () => {
    for (const lc of [2, 3, 4, 5, 6, 8]) {
      const u = { id: 'u0', text: 'ですゆうそう', words, sourceStart: 0.62, sourceEnd: 1.46 }
      const chunks = utteranceToTelopChunks(u as never, { maxLineChars: lc, dictionary: YT })
      // 枚の頭は時刻順で、どの枚も次の枚の頭までに終わる(辞書で長くした長さ 0 の言葉の後ろの枚の頭が、次の
      // 言葉の頭より後ろになると、前の枚の終わりがそこまで延びて次の枚に重なっていた)
      chunks.forEach((c, k) => {
        expect(c.sourceEnd, `${lc} ${c.text}`).toBeGreaterThanOrEqual(c.sourceStart)
        if (k > 0)
          expect(c.sourceStart, `${lc} ${c.text}`).toBeGreaterThanOrEqual(chunks[k - 1].sourceEnd)
      })
      chunks.forEach((c, k) => {
        const [lo, hi] = c.range!.map((x) => Number(x.toFixed(3)))
        for (const t of chunks.filter((_, j) => j !== k).flatMap((x) => x.times ?? []))
          expect(t < lo - 1e-9 || t > hi + 1e-9, `${lc} ${c.text} ${t} [${lo},${hi}]`).toBe(true)
      })
    }
  })
})

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

/**
 * 性質(乱択): 短い発話・長さ 0 の言葉・辞書で長くした言葉・1行の短い長さ・ランダムなカットで
 * - 枚の頭が時刻順で、枚が重ならない(声の重ならない発話だけ)。同じ発話の枚は何枚目かの順
 * - カットの外の言葉の文字が出ない(枚の置かれた区間で話していない言葉の文字)
 * - 声のある言葉(区間の中で話し終える)は、声が十分あれば消えない(0.3 秒に満たない枚は出さないので、
 *   1文字あたり 0.3 秒以上なら1文字も欠けない・0.3 秒 ×(行数 + 1)以上なら丸ごとは消えない)
 * - 1行が1行の文字数を超えない(第63回の監査 3: まとめた枚の1行が文字数を大きく超えていた)
 * - どの枚も 0.3 秒以上(次の発言の頭で終える枚を除く)
 * - 1枚を消す・直して作り直しても、ほかの枚の文字はそのまま
 * 言葉は1文字ずつどれも違う漢字(辞書で直した後の文字も違う字)と言いよどみ。試す数は `TELOP_R62_SEEDS`(既定 1500)
 */
describe('短い枚の性質(乱択)', () => {
  it('時刻順・重ならない・カットの外の文字が出ない・声のある言葉が消えない', () => {
    const N = Number(process.env.TELOP_R62_SEEDS ?? 1500)
    const fails: string[] = []
    let checkedVoiced = 0
    let checkedWhole = 0
    let roundTrips = 0
    let roundTripSkipped = 0
    const ONLY = Number(process.env.TELOP_R62_SEED ?? 0)
    for (let seed = ONLY || 1; seed <= (ONLY || N); seed++) {
      const r = rng(seed * 7919)
      let code = 0x4e00
      let rep = 0x8a00
      let t = 0.3 + r() * 0.5
      const dict: { from: string; to: string }[] = []
      /** 文字 → 言葉(辞書で直した文字は直す前の言葉) */
      const wordOf = new Map<string, W>()
      /** 言葉 → 出るはずの文字 */
      const shownOf = new Map<W, string[]>()
      const utts: W[][] = []
      const nu = 1 + Math.floor(r() * 3)
      for (let k = 0; k < nu; k++) {
        const words: W[] = []
        const n = 1 + Math.floor(r() * 6)
        for (let i = 0; i < n; i++) {
          if (r() < 0.12) {
            // 言いよどみ(枚の境目で分かれると切れ端が残る)
            const d = r() < 0.3 ? 0 : 0.1 + r() * 0.3
            words.push({ text: r() < 0.5 ? 'えっと' : 'えーと', start: t, end: t + d })
            t += d
          }
          let text = ''
          const len = 1 + Math.floor(r() * 3)
          for (let c = 0; c < len; c++) {
            text += String.fromCodePoint(code)
            code += 3
          }
          const d = r() < 0.35 ? 0 : 0.05 + r() * 0.5
          const w = { text, start: t, end: t + d }
          let shown = [...text]
          if (len >= 2 && r() < 0.5) {
            let to = ''
            const L = 2 + Math.floor(r() * 14)
            for (let c = 0; c < L; c++) to += String.fromCodePoint(rep++)
            dict.push({ from: text, to })
            shown = [...to]
          }
          for (const c of [...text, ...shown]) wordOf.set(c, w)
          shownOf.set(w, shown)
          words.push(w)
          t += d === 0 && r() < 0.6 ? 0 : d + r() * 0.3
        }
        utts.push(words)
        t = words[words.length - 1].end + 0.3 + r() * 1.5
      }
      const total = t + 1
      const nc = Math.floor(r() * 3)
      const cuts = Array.from({ length: nc * 2 }, () => r() * total).sort((a, b) => a - b)
      const scenes: { start: number; end: number }[] = []
      let from = 0
      for (let i = 0; i < nc; i++) {
        if (cuts[i * 2] - from > 0.4) scenes.push({ start: from, end: cuts[i * 2] })
        from = Math.max(from, cuts[i * 2 + 1])
      }
      if (total + 1 - from > 0.4) scenes.push({ start: from, end: total + 1 })
      if (scenes.length === 0) continue
      const lc = 2 + Math.floor(r() * 7)
      const res = planCut(utts, scenes, lc, dict)
      const a = res.telops as Auto[]
      // 仮編集の区間(カットは静かな所へ寄せるので、場面の端とは少し違う)
      const spans = res.cut.spans
      const tag = `seed${seed} lc${lc} ${JSON.stringify(utts)} ${JSON.stringify(dict)} ${JSON.stringify(spans)} :: ${show(a)}`
      const sorted = [...a].sort((x, y) => x.startTime - y.startTime)
      sorted.forEach((x, i) => {
        const y = sorted[i + 1]
        // 次の発言の頭で終える枚(発言の間が短い)は短くてよい
        const cutByNext = y && y.utteranceId !== x.utteranceId && y.startTime <= x.endTime + 1e-6
        if (x.endTime - x.startTime < 0.3 - 1e-6 && !cutByNext) fails.push(`短い ${flat(x)} ${tag}`)
        if (y && y.startTime < x.endTime - 1e-6) fails.push(`重なり ${flat(x)}/${flat(y)} ${tag}`)
        if (
          y &&
          y.utteranceId === x.utteranceId &&
          (y.utteranceChunk ?? 0) < (x.utteranceChunk ?? 0)
        )
          fails.push(`順 ${flat(x)}/${flat(y)} ${tag}`)
      })
      if (a.some((x, i) => i > 0 && x.startTime < a[i - 1].startTime - 1e-6))
        fails.push(`頭の順 ${tag}`)
      // カットの外の文字
      for (const x of a) {
        const mid = (x.startTime + x.endTime) / 2
        const sp = spans.find((s) => mid >= s.timeline && mid < s.timeline + s.end - s.start)
        if (!sp) {
          fails.push(`区間の外 ${flat(x)} ${tag}`)
          continue
        }
        for (const c of flat(x)) {
          const w = wordOf.get(c)
          if (!w) continue
          const ok =
            w.end > w.start
              ? w.end > sp.start + 1e-6 && w.start < sp.end - 1e-6
              : w.start >= sp.start - 1e-6 && w.start <= sp.end + 1e-6
          if (!ok) fails.push(`カットの外の「${c}」 ${flat(x)} ${tag}`)
        }
      }
      // 1行の文字数を超えない
      for (const x of a)
        for (const line of x.text.split('\n'))
          if ([...line].length > lc) fails.push(`1行が長い「${line}」 ${tag}`)
      // どの枚も、文字ごとの話している時刻を持つ(その文字の言葉の時刻の近く。長さ 0 の言葉の文字は 0.01 秒おきに並べる)
      for (const x of a) {
        const times = x.autoSource?.times
        const cs = [...flat(x)]
        if (times?.length !== cs.length) {
          fails.push(`文字の時刻の数 ${flat(x)} ${tag}`)
          continue
        }
        // 言いよどみの切れ端の印は、かなの文字に付く
        for (const k of x.autoSource?.fill ?? [])
          if (!/[ぁ-んー]/.test(cs[k] ?? '')) fails.push(`切れ端の印 ${k} ${flat(x)} ${tag}`)
        cs.forEach((c, k) => {
          const w = wordOf.get(c)
          if (w && (times[k] < w.start - 0.3 || times[k] > w.end + 0.3))
            fails.push(`文字の時刻 ${c} ${times[k]} ${tag}`)
        })
      }
      // 1枚を消す・直して作り直しても、ほかの枚の文字はそのまま(枚の元の部分が正しい)
      if (a.length > 0) {
        const tl = ids(a)
        const S = tl[Math.floor(r() * tl.length)] as TextOverlay & WithAutoSource
        // 消した印の鍵は範囲を 1/1000 秒に丸めて覚えるので、隣の枚の文字が 1/1000 秒より近い所(辞書で
        // 長くした長さ 0 の言葉の文字)は見分けられない(残った懸念。ここでは確かめない)
        const lo = Number(Math.max(0, S.autoSource?.start ?? 0).toFixed(3))
        const hi = Number((S.autoSource?.end ?? 0).toFixed(3))
        const blurred = tl.some(
          (x) =>
            x !== S &&
            (x as WithAutoSource).autoSource?.times?.some((t) => t >= lo - 1e-9 && t <= hi + 1e-9)
        )
        if (blurred) roundTripSkipped++
        else roundTrips++
        const del = mergeManualTelops(
          tl.filter((x) => x !== S),
          planCut(utts, scenes, lc, dict).telops,
          new Set([autoTelopKey(S)!])
        )
        const rest = tl.filter((x) => x !== S).map(flat)
        if (!blurred && JSON.stringify(del.map(flat)) !== JSON.stringify(rest))
          fails.push(`消す ${flat(S)} → ${del.map(flat).join(' | ')} ${tag}`)
        // 言いよどみの切れ端だけの枚を直した修正は出さない(そう決めてある)
        const fillOnly = (S.autoSource?.fill?.length ?? 0) === flat(S).length
        const edTl = tl.map((x) => (x === S ? { ...x, text: 'E', edited: true } : x))
        const ed = mergeManualTelops(
          edTl,
          planCut(utts, scenes, lc, dict).telops,
          new Set(),
          rememberEditedTelops(edTl, undefined)
        )
        const want = edTl.map((x) => (x.edited ? '[E]' : flat(x))).join(' | ')
        const got = ed.map((x) => (x.edited ? `[${x.text}]` : flat(x))).join(' | ')
        if (!blurred && !fillOnly && got !== want) fails.push(`直す ${flat(S)} → ${got} ${tag}`)
      }
      // 声のある言葉
      const seen = new Set(a.flatMap((x) => [...flat(x)]))
      for (const words of utts)
        for (const sp of spans) {
          // 言いよどみは出さないので、声の長さに数えない
          const ws = words.filter((w) => {
            const m = (w.start + w.end) / 2
            return shownOf.has(w) && m >= sp.start && m < sp.end
          })
          if (ws.length === 0) continue
          const extent =
            Math.max(...ws.map((w) => Math.min(w.end, sp.end))) -
            Math.min(...ws.map((w) => Math.max(w.start, sp.start)))
          if (extent < 0.3 + 1e-6) continue
          for (const w of ws) {
            // 0.3 秒に満たない枚は出さない(第63回の、短い枚を隣の枚にまとめる仕組みはやめた)。辞書で長くした
            // 言葉・枚の境目で分かれた言葉は、一部の文字の枚が 0.3 秒に満たず出ないことがある(既知の制限)。
            // 声が十分ある言葉は丸ごとは消えない、1文字あたり 0.3 秒以上の言葉は1文字も欠けない、を確かめる
            if (w.end - w.start < 0.3 || w.start < sp.start || w.end > sp.end) continue
            checkedVoiced++
            const shown = shownOf.get(w)!
            // 枚の境目で言葉が分かれて辞書が当たらなければ、元の文字のまま出る
            const missing = shown.filter((c) => !seen.has(c))
            const whole = w.end - w.start >= 0.3 * shown.length
            if (whole && missing.length > 0 && [...w.text].some((c) => !seen.has(c)))
              fails.push(`欠けた「${w.text}」(${missing.join('')}) ${tag}`)
            // 辞書で長くした言葉は何枚にも分かれ、枚の境目でも分かれるので、丸ごと消えないのは声が
            // 0.3 秒 ×(行数 + 1)以上あるとき(どれかの枚に 0.3 秒以上の声が入る)
            const lines = Math.ceil(shown.length / lc)
            if (
              w.end - w.start >= 0.3 * (lines + 1) &&
              missing.length === shown.length &&
              [...w.text].every((c) => !seen.has(c))
            )
              fails.push(`消えた「${w.text}」 ${tag}`)
            if (whole) checkedWhole++
          }
        }
    }
    if (process.env.TELOP_R62_PRINT)
      console.log(
        `round trips ${roundTrips} skipped ${roundTripSkipped} voiced ${checkedVoiced} whole ${checkedWhole}`
      )
    if (fails.length > 0)
      console.log(
        `${fails.length} fails\n${fails.slice(0, Number(process.env.TELOP_R62_PRINT ?? 8)).join('\n')}`
      )
    expect(fails.slice(0, 5)).toEqual([])
    if (!ONLY) {
      expect(checkedVoiced).toBeGreaterThan(N)
      expect(roundTrips).toBeGreaterThan(N * 0.8)
      expect(roundTripSkipped).toBeLessThan(N * 0.01)
    }
  }, 120000)
})

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
  normalizeAutoSource,
  rememberEditedTelops
} from '@shared/telop/manual'
import { TURN_RATE } from '@shared/diarize/micTurns'
import { defaultTextStyle } from '@shared/textStyle'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { EditedTelop, Project, TextOverlay } from '@shared/types'

/**
 * 人の修正・消した印の性質の試験(厳しい版)。複数文字の言葉・句読点・言いよどみの連なり・長さの変わる
 * 辞書・直し直し・見た目だけの修正・時刻を動かした修正・取り消しで戻す・保存と読み込み・ショートの別の
 * カットを混ぜ、作り直しのたびに確かめる:
 * (a) 同じ言葉が2枚に出ない (b) 聞こえる言葉は、消した・直したものでなければちょうど1回出る
 * (c) 消していない修正は、その言葉が聞こえるならちょうど1回出る (d) 消した言葉は出ない
 * (e) 同じ発話の枚が重ならない・長さが正 (f) 自動の枚の話者・スタイル・印 (g) 鍵が重ならない
 * (y) 切り分けた枚は 0.3 秒以上
 *
 * 正しい結果(どの言葉を直した・消したか)は実装とは別に覚える。ただし次の所は、その覚え方では
 * 正解が決まらないので確かめない(実装の誤りを見逃さないよう、狭く限る):
 * - 辞書で直す言葉の一部だけを出した枚(カット・枚の境目で言葉が分かれた)を直した・消した所。
 *   その言葉の残りの部分・直した後の形を出すべきかは決められない(実装は話している時刻で分ける)
 * - 漢字を含まない枚(言いよどみの切れ端)を直した修正の、出る回数(聞こえるかを言葉で判断できない。
 *   1 回以下とだけ確かめる)
 * - 元の枚が短く、切り分けた枚を全部 0.3 秒にできない所(元の枚の外へ延ばすとカットを越える)
 * 試す数は `TELOP_HARSH_SEEDS`(既定 200)、1つだけ詳しく見るときは `TELOP_HARSH_SEED`
 */
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
const info: MulticamInfo = {
  anchorSourceId: 'cam',
  sources: [
    { id: 'cam', name: '画面', kind: 'camera', cameraRole: 'screen' },
    { id: 'a', name: 'A', kind: 'mic' }
  ],
  files: [
    { assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: 400 },
    { assetId: 'MA', sourceId: 'a', start: 0, rate: 1, duration: 400 }
  ]
}
type Word = { text: string; start: number; end: number }
const FILLERS = ['えー、', 'あのー、', 'えっと、', 'まあ、', 'えーと、']
interface Gen {
  project: Project
  total: number
  activity: Uint8Array
  dict: { from: string; to: string }[]
  atom: Map<string, string[]> // char -> all chars of its atom
}
const MODE = (process.env.TELOP_HARSH_MODE ?? 'all').split(',')
const on = (m: string): boolean => MODE.includes('all') || MODE.includes(m)

function makeProject(r: () => number): Gen {
  let t = 1
  let code = 0x4e00
  let rep = 0x8a00
  const dict: { from: string; to: string }[] = []
  const atom = new Map<string, string[]>()
  const transcript = Array.from({ length: 4 }, (_, k) => {
    const n = 4 + Math.floor(r() * 10)
    const words: Word[] = []
    const push = (text: string, speed: number): void => {
      const d = (0.12 + r() * 0.2) * [...text].length * speed
      words.push({ text, start: t, end: t + d })
      t += d + 0.02 + r() * (r() < 0.1 ? 1.2 : 0.2)
    }
    for (let i = 0; i < n; i++) {
      if (on('filler') && r() < 0.15) {
        const m = r() < 0.3 ? 4 : 1
        for (let q = 0; q < m; q++) push(FILLERS[Math.floor(r() * FILLERS.length)], 1)
      }
      const len = on('multi') || on('dict') ? 1 + Math.floor(r() * 3) : 1
      let w = ''
      for (let c = 0; c < len; c++) {
        w += String.fromCodePoint(code)
        code += 3
      }
      if (on('dict') && len >= 2 && r() < 0.3) {
        const L = 1 + Math.floor(r() * 5)
        let to = ''
        for (let c = 0; c < L; c++) to += String.fromCodePoint(rep++)
        dict.push({ from: w, to })
        for (const c of [...w, ...to]) atom.set(c, [...w, ...to])
      }
      if (on('punct') && r() < 0.25) w += r() < 0.5 ? '、' : '。'
      push(w, 1)
    }
    const u = {
      id: `u${k}`,
      assetId: 'MA',
      speaker: 'A',
      sourceStart: words[0].start,
      sourceEnd: words[words.length - 1].end,
      text: words.map((w) => w.text).join(''),
      words,
      overlap: false
    }
    t += 1 + r() * 2
    return u
  })
  const activity = new Uint8Array(400 * TURN_RATE)
  for (const u of transcript)
    activity.fill(1, Math.floor(u.sourceStart * TURN_RATE), Math.ceil(u.sourceEnd * TURN_RATE))
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
  return { project, total: t, activity, dict, atom }
}

function randomPlan(r: () => number, p: Gen): Omit<TextOverlay, 'id'>[] {
  const n = 1 + Math.floor(r() * 3)
  const cuts = Array.from({ length: n * 2 }, () => r() * p.total).sort((a, b) => a - b)
  const scenes = Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    start: cuts[i * 2],
    end: Math.max(cuts[i * 2] + 0.5, cuts[i * 2 + 1]),
    lines: [],
    speech: 0
  }))
  const lineChars = 4 + Math.floor(r() * 12)
  return planRoughCut(
    p.project,
    info,
    scenes,
    scenes.map((s) => ({ sceneId: s.id, score: 100, kind: 'highlight' as const, reason: '' })),
    p.activity,
    {
      targetSec: 0,
      keep: Object.fromEntries(scenes.map((s) => [s.id, true])),
      styles: [],
      speechLook: { style: defaultTextStyle() },
      kind: 'game',
      policy: 'light',
      dictionary: p.dict,
      style: { telopLineChars: lineChars } as never
    }
  ).telops
}
const kanji = (s: string): string[] => [...s].filter((c) => /\p{Script=Han}/u.test(c))
interface Model {
  edits: Map<string, Set<string>>
  dismissed: Set<string>
  ambiguous: Set<string>
}
const stats = {
  fails: new Map<string, number>(),
  examples: new Map<string, string>(),
  minDur: Infinity,
  short: 0,
  pieces: 0
}
function fail(kind: string, msg: string): void {
  stats.fails.set(kind, (stats.fails.get(kind) ?? 0) + 1)
  if (!stats.examples.has(kind)) stats.examples.set(kind, msg)
}
function check(
  merged: readonly Omit<TextOverlay, 'id'>[],
  plain: readonly Omit<TextOverlay, 'id'>[],
  m: Model,
  tag: string
): void {
  const audible = new Set(plain.flatMap((t) => kanji(t.text)))
  const count = new Map<string, number>()
  for (const t of merged) for (const c of kanji(t.text)) count.set(c, (count.get(c) ?? 0) + 1)
  const covered = new Set([...m.edits.values()].flatMap((s) => [...s]))
  const pc = new Map<string, number>()
  for (const t of plain) for (const c of kanji(t.text)) pc.set(c, (pc.get(c) ?? 0) + 1)
  const plainDup = [...pc].filter(([, n]) => n > 1).map(([c]) => c)
  // 仮編集そのものが同じ言葉を2枚に出すのも誤り(辞書で長くなって何枚かに分けた枚で起きていた)
  if (plainDup.length)
    fail(
      'a-plan-dup',
      `${tag} ${plainDup.join('')} :: ${plain.map((t) => t.text.replace(/\n/g, '')).join(' | ')}`
    )
  for (const c of m.ambiguous) audible.delete(c)
  for (const [c, n] of count)
    if (n !== 1)
      fail(
        'a-dup',
        `${tag} 「${c}」x${n} :: ${merged.map((t) => t.text.replace(/\n/g, '')).join(' | ')}`
      )
  for (const c of audible)
    if (!m.dismissed.has(c) && !covered.has(c) && (count.get(c) ?? 0) !== 1)
      fail(
        'b-lost',
        `${tag} 「${c}」lost :: merged=${merged.map((t) => t.text.replace(/\n/g, '')).join(' | ')} :: plain=${plain.map((t) => t.text.replace(/\n/g, '')).join(' | ')}`
      )
  for (const [text, words] of m.edits) {
    const n = merged.filter((t) => t.text === text).length
    // 聞こえるか: 修正した言葉のどれかが(人の修正の無い)仮編集に出るか。決められない言葉だけが
    // 出るなら、出る回数は 1 回以下とだけ確かめる
    const heard = [...words].filter((w) => pc.has(w))
    const judged = heard.some((w) => !m.ambiguous.has(w))
    const expected = judged ? 1 : heard.length > 0 || words.size === 0 ? -1 : 0
    if (expected < 0 ? n > 1 : n !== expected)
      fail(
        expected === 0 ? 'c-edit-inaudible' : 'c-edit-count',
        `${tag} edit ${text} [${[...words].join('')}] n=${n} :: ${merged.map((t) => t.text.replace(/\n/g, '')).join(' | ')}`
      )
  }
  const autoCount = new Set(merged.filter((t) => !t.edited).flatMap((t) => kanji(t.text)))
  for (const t of merged)
    if (t.edited && !m.edits.has(t.text))
      fail(
        'h-stale-edit',
        `${tag} ${t.text} :: ${merged.map((t) => t.text.replace(/\n/g, '')).join(' | ')}`
      )
  for (const c of count.keys()) {
    if (m.ambiguous.has(c)) continue
    if (m.dismissed.has(c))
      fail(
        'd-resurrect',
        `${tag} dismissed 「${c}」 :: ${merged.map((t) => t.text.replace(/\n/g, '')).join(' | ')}`
      )
    if (covered.has(c) && autoCount.has(c))
      fail(
        'd-covered-auto',
        `${tag} covered 「${c}」 :: ${merged.map((t) => t.text.replace(/\n/g, '')).join(' | ')}`
      )
  }
  // timing / fields
  const byU = new Map<string, Omit<TextOverlay, 'id'>[]>()
  for (const t of merged)
    if (t.utteranceId) byU.set(t.utteranceId, [...(byU.get(t.utteranceId) ?? []), t])
  for (const [, ts] of byU) {
    const s = [...ts].sort((a, b) => a.startTime - b.startTime)
    for (let i = 0; i < s.length; i++) {
      const d = s[i].endTime - s[i].startTime
      if (!(d > 1e-6)) fail('e-nonpos-dur', `${tag} ${s[i].text} ${s[i].startTime}-${s[i].endTime}`)
      if (!Number.isFinite(s[i].startTime) || !Number.isFinite(s[i].endTime)) fail('e-nan', tag)
      if (i > 0 && s[i].startTime < s[i - 1].endTime - 1e-6)
        fail(
          'e-overlap',
          `${tag} ${s[i - 1].text}[${s[i - 1].startTime.toFixed(3)}-${s[i - 1].endTime.toFixed(3)}] vs ${s[i].text}[${s[i].startTime.toFixed(3)}-${s[i].endTime.toFixed(3)}]`
        )
    }
  }
  for (const t of plain) if (t.endTime - t.startTime < 0.3) fail('y-plain-short(<0.3s)', `${tag}`)
  for (const t of merged) {
    if (
      t.endTime - t.startTime >= 0.3 ||
      plain.some((p) => p.text === t.text && Math.abs(p.startTime - t.startTime) < 1e-6)
    )
      continue
    // 元の枚(同じ発話で時刻の重なる仮編集の枚)に、そこへ切り分けた枚が 0.3 秒ずつ入りきらないなら仕方ない
    const hosts = plain.filter(
      (p) =>
        p.utteranceId === t.utteranceId &&
        p.startTime < t.endTime - 1e-6 &&
        p.endTime > t.startTime + 1e-6
    )
    const lo = Math.min(...hosts.map((p) => p.startTime))
    const hi = Math.max(...hosts.map((p) => p.endTime))
    const inside = merged.filter(
      (x) => x.utteranceId === t.utteranceId && x.startTime >= lo - 1e-6 && x.endTime <= hi + 1e-6
    ).length
    if (hosts.length > 0 && hi - lo < 0.3 * Math.max(2, inside)) continue
    fail(
      'y-carved-short(<0.3s)',
      `${tag} ${t.edited ? '*' : ''}${t.text} ${(t.endTime - t.startTime).toFixed(3)}s`
    )
  }
  for (const t of merged) {
    if (!t.edited) {
      stats.pieces++
      const d = t.endTime - t.startTime
      if (d < stats.minDur) stats.minDur = d
      if (d < 0.3) stats.short++
      if (t.speaker !== 'A' || t.styleId !== plain[0]?.styleId || t.source !== 'auto')
        fail('f-fields', tag)
    }
  }
  const keys = merged.map((t) => autoTelopKey(t as never)).filter((k) => k)
  if (new Set(keys).size !== keys.length) fail('g-dupkey', `${tag} ${keys.join(' ')}`)
}
function saveLoad<T>(x: T): T {
  return JSON.parse(JSON.stringify(x), (k, v) => (k === 'autoSource' ? normalizeAutoSource(v) : v))
}
const expand = (p: Gen, cs: Iterable<string>): Set<string> => {
  const out = new Set<string>()
  for (const c of cs) for (const x of p.atom.get(c) ?? [c]) out.add(x)
  return out
}

describe('人の修正・消した印の性質(厳しい版: 辞書・言いよどみ・句読点・直し直し・取り消し)', () => {
  it('作り直し・保存・ショートを重ねても、言葉が2回出ない・消えない・消したものが戻らない', () => {
    const N = Number(process.env.TELOP_HARSH_SEEDS ?? 200)
    let merges = 0
    const ONLY = process.env.TELOP_HARSH_SEED ? Number(process.env.TELOP_HARSH_SEED) : 0
    const dbg = (...a: unknown[]): void => {
      if (ONLY) console.log(...a)
    }
    for (let seed = ONLY || 1; seed <= (ONLY || N); seed++) {
      const r = rng(seed * 7919)
      const p = makeProject(r)
      const m: Model = { edits: new Map(), dismissed: new Set(), ambiguous: new Set() }
      let timeline: TextOverlay[] = []
      let dismissed = new Set<string>()
      let remembered: Record<string, EditedTelop> | undefined
      let nextEdit = 0
      const hist: {
        timeline: TextOverlay[]
        dismissed: Set<string>
        remembered: typeof remembered
        m: Model
      }[] = []
      for (let step = 0; step < 7; step++) {
        const plain = randomPlan(r, p)
        const merged = mergeManualTelops(timeline, plain, dismissed, remembered)
        remembered = rememberEditedTelops(timeline, remembered)
        const fmt = (ts: readonly Omit<TextOverlay, 'id'>[]): string =>
          ts
            .map(
              (t) =>
                `${t.edited ? '*' : ''}${t.text.replace(/\n/g, '')}[${t.utteranceId}#${t.utteranceChunk} ${t.startTime.toFixed(2)}-${t.endTime.toFixed(2)} src=${(t as never as { autoSource?: { start: number; end: number } }).autoSource?.start.toFixed(3)}-${(t as never as { autoSource?: { start: number; end: number } }).autoSource?.end.toFixed(3)}]`
            )
            .join('\n    ')
        dbg(
          `--- step${step}\n  plain:\n    ${fmt(plain)}\n  merged:\n    ${fmt(merged)}\n  dismissed: ${[...dismissed].join(' ')}\n  remembered: ${Object.entries(
            remembered ?? {}
          )
            .map(([k, v]) => k + '=' + v.text)
            .join(
              ' '
            )}\n  model: edits=${[...m.edits].map(([k, v]) => k + ':' + [...v].join('')).join(' ')} dismissed=${[...m.dismissed].join('')}`
        )
        check(merged, plain, m, `seed${seed}/step${step}`)
        merges++
        if (r() < 0.3) {
          const short = randomPlan(r, p)
          check(
            mergeManualTelops(timeline, short, dismissed, remembered),
            short,
            m,
            `seed${seed}/step${step}/short`
          )
        }
        timeline = merged.map((o, i) => ({ ...o, id: `s${seed}-${step}-${i}` }))
        ;({ timeline, dismissed, remembered } = saveLoad({
          timeline,
          dismissed: [...dismissed],
          remembered
        }) as never)
        dismissed = new Set(dismissed as unknown as string[])
        if (on('undo') && hist.length > 0 && r() < 0.15) {
          const h = hist[Math.floor(r() * hist.length)]
          dbg('  UNDO')
          timeline = [...h.timeline]
          dismissed = new Set(h.dismissed)
          remembered = h.remembered
          m.edits = new Map([...h.m.edits].map(([k, v]) => [k, new Set(v)]))
          m.dismissed = new Set(h.m.dismissed)
          m.ambiguous = new Set(h.m.ambiguous)
        }
        const actions = Math.floor(r() * 4)
        for (let a = 0; a < actions && timeline.length > 0; a++) {
          hist.push({
            timeline: [...timeline],
            dismissed: new Set(dismissed),
            remembered,
            m: {
              edits: new Map([...m.edits].map(([k, v]) => [k, new Set(v)])),
              dismissed: new Set(m.dismissed),
              ambiguous: new Set(m.ambiguous)
            }
          })
          const i = Math.floor(r() * timeline.length)
          const t = timeline[i]
          const words = t.edited
            ? (m.edits.get(t.text) ?? new Set<string>())
            : expand(p, kanji(t.text))
          // 辞書で直す言葉の一部だけを出した枚: その言葉の残り・直した形の扱いは決められない
          if (!t.edited) {
            const shownChars = new Set(kanji(t.text))
            for (const d of p.dict) {
              const from = [...d.from]
              const to = [...d.to]
              const hit = [...from, ...to].some((c) => shownChars.has(c))
              const whole =
                to.every((c) => shownChars.has(c)) || from.every((c) => shownChars.has(c))
              if (hit && !whole) for (const c of [...from, ...to]) m.ambiguous.add(c)
            }
          }
          const x = r()
          dbg(`  action on ${t.text.replace(/\n/g, '')} key=${autoTelopKey(t)} x=${x.toFixed(2)}`)
          if (x < 0.45) {
            const text = `E${nextEdit++}` + 'x'.repeat(Math.floor(r() * 30))
            if (t.edited) m.edits.delete(t.text)
            m.edits.set(text, words)
            const patch: Partial<TextOverlay> = { text, edited: true, words: undefined }
            if (on('retime') && r() < 0.3) {
              patch.endTime = t.endTime + r() * 2
              patch.startTime = Math.max(0, t.startTime - r())
            }
            timeline[i] = { ...t, ...patch }
          } else if (x < 0.55 && on('style')) {
            // style-only edit: text stays → covered words keep appearing as this edited text
            if (!t.edited) {
              m.edits.set(t.text, words)
            }
            timeline[i] = { ...t, style: { ...t.style, fontSize: 99 }, edited: true }
          } else {
            if (t.edited) m.edits.delete(t.text)
            for (const w of words) m.dismissed.add(w)
            dismissed.add(autoTelopKey(t)!)
            remembered = rememberEditedTelops(timeline, remembered)
            timeline = timeline.filter((_, k) => k !== i)
          }
        }
      }
    }
    const real = [...stats.fails]
    const rep = real.map(([k, v]) => `${k}: ${v}\n   e.g. ${stats.examples.get(k)}`).join('\n')
    if (process.env.TELOP_HARSH_REPORT || real.length > 0)
      console.log(
        `MODE=${MODE} merges=${merges} pieces=${stats.pieces} minDur=${stats.minDur.toFixed(4)} short(<0.3s)=${stats.short}\n${rep}`
      )
    expect(rep).toBe('')
    expect(merges).toBeGreaterThan(ONLY ? 0 : N * 7 - 1)
  }, 120000)
})

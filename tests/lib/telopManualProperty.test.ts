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
 * 人の修正・消した印と、作り直し(カット・1行の長さ・保存と読み込み・ショートの別のカット)の性質の試験。
 *
 * 言葉は1文字ずつ(どれも違う漢字)にして、テロップの文字から元の言葉が分かるようにする。人の操作の
 * 正しい結果は、実装とは別に「どの言葉を直した・消したか」で覚えておき、毎回の作り直しで確かめる:
 * (a) 同じ言葉が2枚に出ない
 * (b) 聞こえる(人の修正の無い作り直しで出る)言葉は、消した・直したものでなければちょうど1回出る
 * (c) 消していない修正は、その言葉が聞こえるならちょうど1回、聞こえなければ出ない
 * (d) 消した言葉は出ない
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
    { assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: 200 },
    { assetId: 'MA', sourceId: 'a', start: 0, rate: 1, duration: 200 }
  ]
}

type Word = { text: string; start: number; end: number }

function makeProject(r: () => number): { project: Project; total: number; activity: Uint8Array } {
  let t = 1
  let code = 0x4e00
  const transcript = Array.from({ length: 4 }, (_, k) => {
    const n = 6 + Math.floor(r() * 12)
    const words: Word[] = []
    for (let i = 0; i < n; i++) {
      const d = 0.25 + r() * 0.6
      words.push({ text: String.fromCodePoint(code), start: t, end: t + d })
      code += 3
      t += d + 0.03 + r() * 0.25
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
  const activity = new Uint8Array(200 * TURN_RATE)
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
  return { project, total: t, activity }
}

function randomPlan(r: () => number, p: ReturnType<typeof makeProject>): Omit<TextOverlay, 'id'>[] {
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
  const plan = planRoughCut(
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
      style: { telopLineChars: lineChars } as never
    }
  )
  return plan.telops
}

const kanji = (s: string): string[] => [...s].filter((c) => /\p{Script=Han}/u.test(c))

interface Model {
  /** 修正の文字 → 直した言葉 */
  edits: Map<string, Set<string>>
  dismissed: Set<string>
}

function check(
  merged: readonly { text: string }[],
  plain: readonly { text: string }[],
  m: Model
): void {
  const audible = new Set(plain.flatMap((t) => kanji(t.text)))
  const count = new Map<string, number>()
  for (const t of merged) for (const c of kanji(t.text)) count.set(c, (count.get(c) ?? 0) + 1)
  const covered = new Set([...m.edits.values()].flatMap((s) => [...s]))
  // (a)
  for (const [c, n] of count) expect(n, `「${c}」が ${n} 回`).toBe(1)
  // (b)
  for (const c of audible)
    if (!m.dismissed.has(c) && !covered.has(c))
      expect(count.get(c) ?? 0, `「${c}」が出ない`).toBe(1)
  // (c)
  for (const [text, words] of m.edits) {
    const n = merged.filter((t) => t.text === text).length
    const hears = [...words].some((w) => audible.has(w))
    expect(n, `修正「${text}」`).toBe(hears ? 1 : 0)
  }
  // (d) 消した言葉・直した言葉は自動の文字として出ない
  for (const c of count.keys()) {
    expect(m.dismissed.has(c), `消した「${c}」が出た`).toBe(false)
    expect(covered.has(c), `直した「${c}」が自動の文字で出た`).toBe(false)
  }
}

/** 保存して読み込む(元の部分は読み込みで確かめる) */
function saveLoad<T>(x: T): T {
  return JSON.parse(JSON.stringify(x), (k, v) => (k === 'autoSource' ? normalizeAutoSource(v) : v))
}

describe('人の修正・消した印の性質(ランダムなカット・1行の長さ・保存と読み込み・ショート)', () => {
  it('300 通りの手順で、言葉が2回出ない・消えない・消したものが戻らない', () => {
    let cases = 0
    let merges = 0
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed)
      const p = makeProject(r)
      const m: Model = { edits: new Map(), dismissed: new Set() }
      let timeline: TextOverlay[] = []
      let dismissed = new Set<string>()
      let remembered: Record<string, EditedTelop> | undefined
      let nextEdit = 0
      for (let step = 0; step < 5; step++) {
        const plain = randomPlan(r, p)
        // 作り直し(applyRoughCut と同じ: 今の修正を覚えてから重ねる)
        const merged = mergeManualTelops(timeline, plain, dismissed, remembered)
        remembered = rememberEditedTelops(timeline, remembered)
        check(merged, plain, m)
        merges++
        // ショート: 本編の修正・消した印を、別のカットに当てる(本編は変えない)
        if (r() < 0.5) {
          const short = randomPlan(r, p)
          check(mergeManualTelops(timeline, short, dismissed, remembered), short, m)
          merges++
        }
        timeline = merged.map((o, i) => ({ ...o, id: `s${seed}-${step}-${i}` }))
        // 保存して開き直す
        ;({ timeline, dismissed, remembered } = saveLoad({
          timeline,
          dismissed: [...dismissed],
          remembered
        }) as unknown as {
          timeline: TextOverlay[]
          dismissed: Set<string>
          remembered: typeof remembered
        })
        dismissed = new Set(dismissed as unknown as string[])
        // 人の操作(直す・消す)
        const actions = Math.floor(r() * 3)
        for (let a = 0; a < actions && timeline.length > 0; a++) {
          const i = Math.floor(r() * timeline.length)
          const t = timeline[i]
          const words = t.edited
            ? (m.edits.get(t.text) ?? new Set<string>())
            : new Set(kanji(t.text))
          if (r() < 0.5) {
            const text = `E${nextEdit++}`
            if (t.edited) m.edits.delete(t.text)
            m.edits.set(text, words)
            timeline[i] = { ...t, text, edited: true, words: undefined }
          } else {
            if (t.edited) m.edits.delete(t.text)
            for (const w of words) m.dismissed.add(w)
            dismissed.add(autoTelopKey(t)!)
            remembered = rememberEditedTelops(timeline, remembered)
            timeline = timeline.filter((_, k) => k !== i)
          }
        }
      }
      cases++
    }
    expect(cases).toBe(300)
    expect(merges).toBeGreaterThan(1500)
  }, 60000)
})

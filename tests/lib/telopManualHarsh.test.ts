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
import { removeFillers } from '@shared/telop/polish'
import { perfBudget } from '../perfBudget'
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
  /** 言葉の印 → 話している頭〜終わり(素材の秒) */
  voice: Map<string, [number, number]>
  /** 言いよどみの言葉(まるごとなら整えると消える言葉)のかなの印 */
  fillerTok: Set<string>
}
const MODE = (process.env.TELOP_HARSH_MODE ?? 'all').split(',')
const on = (m: string): boolean => MODE.includes('all') || MODE.includes(m)

function makeProject(r: () => number): Gen {
  let t = 1
  let code = 0x4e00
  let rep = 0x8a00
  const dict: { from: string; to: string }[] = []
  const atom = new Map<string, string[]>()
  const transcript: Project['transcript'] & object = []
  const voice = new Map<string, [number, number]>()
  const fillerTok = new Set<string>()
  // 相づち・言いよどみに似た言葉だけの発話(どの企画でも同じ言葉は1回だけ。言葉を見分けるため)
  const replies = [...REPLIES].sort(() => r() - 0.5)
  /** 言葉の文字の声(漢字は字、かなは「K:発話:何番目の言葉:何文字目」で覚える) */
  const remember = (uid: string, wi: number, w: Word): void => {
    const cs = [...w.text]
    const n = cs.length
    const filler = w.text.trim() !== '' && removeFillers(w.text) === ''
    cs.forEach((c, i) => {
      const iv: [number, number] = [
        w.start + ((w.end - w.start) * i) / n,
        w.start + ((w.end - w.start) * (i + 1)) / n
      ]
      if (/\p{Script=Han}/u.test(c)) voice.set(c, iv)
      else if (KANA.test(c)) {
        voice.set(`K:${uid}:${wi}:${i}`, iv)
        if (filler) fillerTok.add(`K:${uid}:${wi}:${i}`)
      }
    })
    const d = dict.find((e) => w.text.startsWith(e.from) && e.from.length >= 2)
    if (d) {
      const raw = [...d.from].length
      const we = w.start + ((w.end - w.start) * raw) / n
      ;[...d.to].forEach((c, i, all) =>
        voice.set(c, [
          w.start + ((we - w.start) * i) / all.length,
          w.start + ((we - w.start) * (i + 1)) / all.length
        ])
      )
    }
  }
  for (let k = 0; k < 4; k++) {
    const n = 4 + Math.floor(r() * 10)
    const words: Word[] = []
    let zeroNext = false
    const push = (text: string, speed: number): void => {
      // 長さ 0 の言葉(Whisper の語の時刻は 0.02 秒刻みで、長さ 0 がよく出る)。次の言葉がすぐ
      // (0〜0.03 秒後に)続くことが多い
      const zero = on('zero') && r() < 0.1
      const d = zero ? 0 : (0.12 + r() * 0.2) * [...text].length * speed
      if (zeroNext) t += r() < 0.5 ? 0 : 0.02
      words.push({ text, start: t, end: t + d })
      zeroNext = zero && r() < 0.7
      t += zeroNext ? 0 : d + 0.02 + r() * (r() < 0.1 ? 1.2 : 0.2)
    }
    for (let i = 0; i < n; i++) {
      if (on('filler') && r() < 0.15) {
        const m = r() < 0.3 ? 4 : 1
        for (let q = 0; q < m; q++) push(FILLERS[Math.floor(r() * FILLERS.length)], 1)
      }
      // 本当のかなの言葉(助詞・語尾)。言いよどみが後に続くこともある
      if (on('kana') && r() < 0.15) push(PARTICLES[Math.floor(r() * PARTICLES.length)], 1)
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
      // 伸ばした長い1文字の言葉もある(声の長さを覚えていないと、枚が声より早く消える)
      push(w, on('long') && len === 1 && r() < 0.15 ? 6 : 1)
    }
    words.forEach((w, wi) => remember(`u${k}`, wi, w))
    transcript.push({
      id: `u${k}`,
      assetId: 'MA',
      speaker: 'A',
      sourceStart: words[0].start,
      sourceEnd: words[words.length - 1].end,
      text: words.map((w) => w.text).join(''),
      words,
      overlap: false
    })
    t += 1 + r() * 2
    if (on('reply') && replies.length > 0 && r() < 0.4) {
      const text = replies.pop()! + (r() < 0.2 ? '、' : '')
      const d = r() < 0.3 ? 0 : 0.2 + r() * 0.5
      remember(`r${k}`, 0, { text, start: t, end: t + d })
      transcript.push({
        id: `r${k}`,
        assetId: 'MA',
        speaker: 'A',
        sourceStart: t,
        sourceEnd: t + d,
        text,
        words: [{ text, start: t, end: t + d }],
        overlap: false
      })
      t += d + 1 + r() * 2
    }
  }
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
  return { project, total: t, activity, dict, atom, voice, fillerTok }
}

type Spans = { timeline: number; start: number; end: number }[]
export let lastSpans: Spans = []
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
  const res = planRoughCut(
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
  )
  lastSpans = res.cut.spans
  return res.telops
}
const kanji = (s: string): string[] => [...s].filter((c) => /\p{Script=Han}/u.test(c))
/** 相づち・言いよどみに似た本当の言葉(言いよどみとして消さない。人の修正も消さない) */
const REPLIES = ['そう', 'うん', 'ええ', 'あの', 'あと', 'まま', 'はい', 'えっ', 'そうそう']
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u
/** 本当のかなの言葉(助詞・語尾など) */
const PARTICLES = ['は', 'を', 'です', 'ね', 'から', 'そうですね', 'まま', 'あと']
let GEN: Gen | null = null
type Tel = { text: string; utteranceId?: string; edited?: boolean } & {
  autoSource?: { times?: number[] }
}
/**
 * テロップの並びの、言葉の印。漢字は1文字ずつどれも違う字なのでそのまま。かなは同じ字が何度も
 * 出るので、出している文字の話している時刻(`autoSource.times`)から、同じ発話のどの言葉の文字かを決め
 * (その言葉の声の近く ±0.1 秒で、同じ字を含む言葉のうち声のいちばん近いもの)、言葉ごとに出ている
 * 文字を時刻の順に言葉の文字へ前から当てて「K:発話:何番目の言葉:何文字目」にする。言葉の文字より多く
 * 出ていれば、余りは「K!」(2回出た)。人が直した枚は文字が人のものなので、漢字だけ
 */
function toksOf(list: readonly Tel[]): Map<Tel, string[]> {
  const out = new Map<Tel, string[]>(list.map((t) => [t, kanji(t.text)]))
  if (!GEN) return out
  const byWord = new Map<string, { t: Tel; c: string; time: number }[]>()
  for (const t of list) {
    if (t.edited || !t.utteranceId) continue
    const times = t.autoSource?.times
    const vis = [...t.text].filter((c) => !/\s/.test(c))
    if (!times || times.length !== vis.length) continue
    const u = GEN.project.transcript?.find((x) => x.id === t.utteranceId)
    if (!u) continue
    vis.forEach((c, k) => {
      if (!KANA.test(c)) return
      let best = -1
      let bestD = Infinity
      let tie = false
      u.words.forEach((w, wi) => {
        if (!w.text.includes(c)) return
        if (times[k] < w.start - 0.1 || times[k] > w.end + 0.1) return
        const d = Math.abs((w.start + w.end) / 2 - times[k])
        if (Math.abs(d - bestD) < 0.03) tie = true
        if (d < bestD) {
          if (bestD - d >= 0.03) tie = false
          bestD = d
          best = wi
        }
      })
      // 同じ時刻の長さ 0 の言葉が並ぶと(「えーと、」「あと」が 38.052 秒)どちらの「と」か決められない
      if (best < 0 || tie) return
      const key = `${u.id}:${best}`
      byWord.set(key, [...(byWord.get(key) ?? []), { t, c, time: times[k] }])
    })
  }
  for (const [key, xs] of byWord) {
    const [uid, wi] = key.split(':')
    const w = GEN.project.transcript!.find((x) => x.id === uid)!.words[Number(wi)]
    const cs = [...w.text]
    let j = 0
    const len = w.end - w.start
    for (const x of [...xs].sort((a, b) => a.time - b.time)) {
      let i = j
      while (i < cs.length && cs[i] !== x.c) i++
      // 長さのある言葉は時刻から何文字目かを決める(後ろの文字だけが出た枚を、頭の文字と取り違えない)
      if (len > 1e-6) {
        let bestD = Infinity
        cs.forEach((ch, k) => {
          const d = Math.abs(w.start + ((k + 0.5) * len) / cs.length - x.time)
          if (ch === x.c && k >= j && d < bestD) {
            bestD = d
            i = k
          }
        })
      }
      out.get(x.t)!.push(i < cs.length ? `K:${key}:${i}` : `K!:${key}:${x.c}`)
      if (i < cs.length) j = i + 1
    }
  }
  return out
}
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
  const tp = toksOf(plain)
  const tm = toksOf(merged)
  const toks = (t: Tel): string[] => tm.get(t) ?? tp.get(t) ?? kanji(t.text)
  const audible = new Set(plain.flatMap((t) => toks(t)))
  const count = new Map<string, number>()
  for (const t of merged) for (const c of toks(t)) count.set(c, (count.get(c) ?? 0) + 1)
  const covered = new Set([...m.edits.values()].flatMap((s) => [...s]))
  const pc = new Map<string, number>()
  for (const t of plain) for (const c of toks(t)) pc.set(c, (pc.get(c) ?? 0) + 1)
  const plainDup = [...pc].filter(([, n]) => n > 1).map(([c]) => c)
  // 仮編集そのものが同じ言葉を2枚に出すのも誤り(辞書で長くなって何枚かに分けた枚で起きていた)
  if (plainDup.length)
    fail(
      'a-plan-dup',
      `${tag} ${plainDup.join('')} :: ${plain.map((t) => t.text.replace(/\n/g, '')).join(' | ')}`
    )
  for (const c of m.ambiguous) audible.delete(c)
  // 言いよどみの言葉のかな(枚の境目で分かれた切れ端は出ることがある。出ても出なくてもよい)
  for (const c of GEN?.fillerTok ?? []) audible.delete(c)
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
    const n = merged.filter((t) => t.edited && t.text === text).length
    // 聞こえるか: 修正した言葉のどれかが(人の修正の無い)仮編集に出るか。決められない言葉だけが
    // 出るなら、出る回数は 1 回以下とだけ確かめる
    const heard = [...words].filter((w) => pc.has(w))
    const judged = heard.some((w) => !m.ambiguous.has(w) && !GEN?.fillerTok.has(w))
    const expected = judged ? 1 : heard.length > 0 || words.size === 0 ? -1 : 0
    if (expected < 0 ? n > 1 : n !== expected)
      fail(
        expected === 0 ? 'c-edit-inaudible' : 'c-edit-count',
        `${tag} edit ${text} [${[...words].join('')}] n=${n} :: ${merged.map((t) => t.text.replace(/\n/g, '')).join(' | ')}`
      )
  }
  const autoCount = new Set(merged.filter((t) => !t.edited).flatMap((t) => toks(t)))
  for (const t of merged)
    if (t.edited && !m.edits.has(t.text))
      fail(
        'h-stale-edit',
        `${tag} ${t.text} :: ${merged.map((t) => t.text.replace(/\n/g, '')).join(' | ')}`
      )
  for (const c of count.keys()) {
    if (m.ambiguous.has(c) || GEN?.fillerTok.has(c)) continue
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
  // 切り分けた枚・直した枚の時間を声と比べる: 声より 0.15 秒以上早く出ない・声が終わる 0.15 秒以上前に
  // 消えない(話している長さを覚えずに文字の間の真ん中・上限で割ると、伸ばした「ね」の途中で消えていた)
  if (!GEN) return
  const toTimeline = (iv: [number, number]): [number, number] | null => {
    const sp = lastSpans.find((x) => iv[0] < x.end - 1e-6 && iv[1] > x.start + 1e-6)
    if (!sp) return null
    const a = Math.max(iv[0], sp.start)
    const b = Math.min(iv[1], sp.end)
    return [sp.timeline + a - sp.start, sp.timeline + b - sp.start]
  }
  for (const t of merged) {
    if (!t.utteranceId) continue
    if (plain.some((x) => x.text === t.text && Math.abs(x.startTime - t.startTime) < 1e-6)) continue
    const all = t.edited ? [...(m.edits.get(t.text) ?? [])].filter((w) => pc.has(w)) : toks(t)
    // 声の終わりは言いよどみの文字を除いて比べる(枚の境目で切れ端だけ出る・別の修正に取られることがある)。
    // 言いよどみの文字だけの枚は比べない
    const ws = all.filter((w) => !GEN!.fillerTok.has(w))
    const iv = (list: string[]): [number, number][] =>
      list
        .map((w) => GEN!.voice.get(w))
        .filter((x) => x !== undefined)
        .map(toTimeline)
        .filter((x) => x !== null)
    const ivs = iv(ws)
    const ivAll = iv(all)
    // 決められない言葉(辞書で直した言葉の一部)を含む修正は、どこまでが修正か決められない
    if (
      ivs.length === 0 ||
      ivs.length < ws.length ||
      ivAll.length < all.length ||
      (t.edited && ws.some((w) => m.ambiguous.has(w)))
    )
      continue
    const vs = Math.min(...ivAll.map((x) => x[0]))
    const ve = Math.max(...ivs.map((x) => x[1]))
    // 仮編集の枚の頭から出る枚は、仮編集と同じ(声の前の間から出す)
    const plainHead = plain.some(
      (x) => x.utteranceId === t.utteranceId && Math.abs(x.startTime - t.startTime) < 1e-6
    )
    // 声が 0.3 秒(切り分けた枚の最短)より短ければ、足りない分だけ前から出してよい。後ろの枚が最短まで
    // 縮められていれば、その分だけ早く消えてよい
    const nextShort = (a: Tel & { endTime: number }): (typeof merged)[number] | undefined =>
      merged.find(
        (x) =>
          x !== a &&
          x.utteranceId === t.utteranceId &&
          Math.abs(x.startTime - a.endTime) < 1e-6 &&
          x.endTime - x.startTime < 0.3 + 1e-3
      )
    let chain = 0
    for (let x = nextShort(t); x && chain < 50; x = nextShort(x)) chain++
    const squeezed = chain > 0
    const early = !plainHead && t.startTime < vs - 0.15 - Math.max(0, 0.3 - (ve - vs)) - 0.3 * chain
    // 元の枚(仮編集)が声より早く終わるなら、その終わりまで(カット・次の枚の頭で切れる)
    const hostEnd = Math.max(
      -Infinity,
      ...plain
        .filter(
          (x) =>
            x.utteranceId === t.utteranceId &&
            x.startTime < t.endTime - 1e-6 &&
            x.endTime > t.startTime + 1e-6
        )
        .map((x) => x.endTime)
    )
    const late = !squeezed && t.endTime < Math.min(ve, hostEnd) - 0.15
    if (early || late)
      fail(
        late ? 'i-voice-end' : 'i-voice-start',
        `${tag} ${t.edited ? '*' : ''}${t.text.replace(/\n/g, '')} ${t.startTime.toFixed(3)}-${t.endTime.toFixed(3)} voice ${vs.toFixed(3)}-${ve.toFixed(3)}`
      )
  }
}
function saveLoad<T>(x: T): T {
  return JSON.parse(JSON.stringify(x), (k, v) => (k === 'autoSource' ? normalizeAutoSource(v) : v))
}
const expand = (p: Gen, cs: Iterable<string>): Set<string> => {
  const out = new Set<string>()
  for (const c of cs) for (const x of p.atom.get(c) ?? [c]) out.add(x)
  return out
}

/** 種の数(既定 200。TELOP_HARSH_SEEDS=5000 で深く探す) */
const N = Number(process.env.TELOP_HARSH_SEEDS ?? 200)

describe('人の修正・消した印の性質(厳しい版: 辞書・言いよどみ・句読点・直し直し・取り消し)', () => {
  it(
    '作り直し・保存・ショートを重ねても、言葉が2回出ない・消えない・消したものが戻らない',
    async () => {
      let merges = 0
      const ONLY = process.env.TELOP_HARSH_SEED ? Number(process.env.TELOP_HARSH_SEED) : 0
      const dbg = (...a: unknown[]): void => {
        if (ONLY) console.log(...a)
      }
      for (let seed = ONLY || 1; seed <= (ONLY || N); seed++) {
        // 長く続けて回すとテストの作業スレッドが応答できなくなるので、ときどき空ける
        if (seed % 100 === 0) await new Promise((r) => setTimeout(r, 0))
        const r = rng(seed * 7919)
        const p = makeProject(r)
        GEN = p
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
              : expand(p, toksOf(timeline).get(t) ?? kanji(t.text))
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
              // (同じ文の別の修正が既にある枚は飛ばす。この確かめ方は修正を文で見分けるため)
              if (!t.edited && m.edits.has(t.text)) continue
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
      // 種 1 つ 0.03 秒ほど(5000 種で 150 秒)。遅い機械でも 5000 種が収まるよう、種の数に合わせて延ばす
    },
    perfBudget(60000 + 150 * N)
  )
})

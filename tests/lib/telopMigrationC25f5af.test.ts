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
import * as OP from './fixtures/telopc25f5af/roughCutPlan'
import * as OM from './fixtures/telopc25f5af/manual'
let OLDNOW = false
const planRoughCut = (...a: unknown[]): { telops: Omit<TextOverlay, 'id'>[] } =>
  (
    (OLDNOW ? OP.planRoughCut : NP.planRoughCut) as (...x: unknown[]) => {
      telops: Omit<TextOverlay, 'id'>[]
    }
  )(...a)
const autoTelopKey = (t: TextOverlay): string | null => NM.autoTelopKey(t)
const mergeManualTelops = (...a: unknown[]): Omit<TextOverlay, 'id'>[] =>
  (
    (OLDNOW ? OM.mergeManualTelops : NM.mergeManualTelops) as (
      ...x: unknown[]
    ) => Omit<TextOverlay, 'id'>[]
  )(...a)
const rememberEditedTelops = (...a: unknown[]): Record<string, EditedTelop> | undefined =>
  (
    (OLDNOW ? OM.rememberEditedTelops : NM.rememberEditedTelops) as (
      ...x: unknown[]
    ) => Record<string, EditedTelop> | undefined
  )(...a)
const normalizeAutoSource = (v: unknown): unknown => (OLDNOW ? v : NM.normalizeAutoSource(v))
let SWITCH = 3
import { TURN_RATE } from '@shared/diarize/micTurns'
import { defaultTextStyle } from '@shared/textStyle'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { EditedTelop, Project, TextOverlay } from '@shared/types'
import * as OF from './fixtures/telopc25f5af/fromTranscript'
import {
  mainHardCuts,
  placedClips,
  telopsFromTranscript
} from '../../src/renderer/src/lib/transcriptTimeline'
import { utteranceTimelineRange } from '@shared/transcript'
import { speechTelopStyle } from '@shared/telop/styles'
import { stackSimultaneousTelops } from '@shared/telop/stack'
import { textCanvasSize } from '@shared/resolution'

/**
 * 前の版(c25f5af、10/09 までの版: テロップに元の部分を覚えず、人の修正・消した印を「発話+何枚目か」の
 * 鍵だけで覚えた)で保存した企画を、今の版で開き直して作り直す試験。前の版で何回か作り直し・人が直した・消した状態を保存し、同じカットで
 * 前の版のまま作り直した結果と、今の版で作り直した結果を、同じ覚え方の正解と比べる。
 * 消したものが戻る・言葉が消える・修正の出る回数の誤りが、前の版のままより多くならないこと
 * (`tests/lib/fixtures/telopc25f5af` は前の版の写し)。試す数は `TELOP_MIGRATE_SEEDS`(既定 2000)。
 *
 * 以下は正解の覚え方(厳しい版の試験と同じ)。
 *
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
 * - 仮編集そのものが同じ言葉を2枚に出した所(z。人の修正と関係のない、区切り方の問題)
 * - 辞書で直す言葉の一部だけを出した枚(カット・枚の境目で言葉が分かれた)を直した・消した所。
 *   その言葉の残りの部分・直した後の形を出すべきかは決められない(実装は話している時刻で分ける)
 * - 漢字を含まない枚(言いよどみの切れ端)を直した修正の、出る回数(聞こえるかを言葉で判断できない)
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
const REPLY_WORDS = ['はい、', 'そう', 'うん', 'あと', 'まま', 'は', 'ね', 'です']
interface Gen {
  project: Project
  total: number
  activity: Uint8Array
  dict: { from: string; to: string }[]
  atom: Map<string, string[]> // char -> all chars of its atom
}
const MODE = (process.env.TELOP_MIGRATE_MODE ?? 'all').split(',')
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
      // 長さ 0 の言葉(Whisper でよく出る。次の言葉が同じ時刻か 0.02 秒後に続く)。前の版はこの言葉の
      // 文字をみな言葉の頭の時刻にしたので、その範囲で覚えた修正・消した印を今の版で当て直す
      if (on('zero') && r() < 0.12) {
        words.push({ text: w, start: t, end: t })
        t += r() < 0.5 ? 0 : 0.02
      } else push(w, 1)
      // 相づち・言いよどみに似た本当の言葉・助詞(かな。言いよどみとして消さない)
      if (on('reply') && r() < 0.12) {
        const kana = REPLY_WORDS[Math.floor(r() * REPLY_WORDS.length)]
        if (r() < 0.4) words.push({ text: kana, start: t, end: t })
        else push(kana, 1)
      }
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

interface Scene {
  id: string
  start: number
  end: number
  lines: never[]
  speech: number
}
/** 最後に作った仮編集の場面(`randomPlan` に `sameCut` を渡すと、場面はそのままで1行の文字数だけ変える) */
let lastScenes: Scene[] = []
let madeScenes: Scene[] = []
function randomPlan(r: () => number, p: Gen, sameCut = false): Omit<TextOverlay, 'id'>[] {
  let scenes = lastScenes
  if (!sameCut) {
    const n = 1 + Math.floor(r() * 3)
    const cuts = Array.from({ length: n * 2 }, () => r() * p.total).sort((a, b) => a - b)
    scenes = Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      start: cuts[i * 2],
      end: Math.max(cuts[i * 2] + 0.5, cuts[i * 2 + 1]),
      lines: [],
      speech: 0
    }))
  }
  madeScenes = scenes
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
let STEP = 0
let PAIRED = false
const COUNTFROM = 0
let PREFIX = ''
export const pairs = new Map<string, string[]>()
/**
 * 誤りを数える。`kind` は「種類」か「種類|既知の型」(前の版と比べられない既知の型)。既知の型は前の版との
 * 比べから除き、`RAW` を付けた名前には除かずに数える(10/09 版の当て方との比べに使う)
 */
function fail(kind: string, msg: string): void {
  const [raw, known] = kind.split('|')
  if (known) msg = `[${known}] ${msg}`
  kind = known || raw
  if (PAIRED) {
    pairs.set(PREFIX + kind, [...(pairs.get(PREFIX + kind) ?? []), msg])
    pairs.set('RAW' + PREFIX + raw, [...(pairs.get('RAW' + PREFIX + raw) ?? []), msg])
    return
  }
  if (STEP < COUNTFROM) return
  stats.fails.set(kind, (stats.fails.get(kind) ?? 0) + 1)
  if (!stats.examples.has(kind)) stats.examples.set(kind, msg)
}
/**
 * 前の版と今の版を比べるときに確かめる言葉(両方の仮編集に出る言葉)。今の版は、前の版が出さなかった言葉
 * (頭をカットで落とした枚・長さ 0 の言葉)も出すので、その言葉の誤りは前の版と比べられない
 */
let BOTH: Set<string> | null = null
/** 前の版と比べるとき(今の版を確かめる間だけ)、同じカットで前の版のまま作り直した仮編集と結果 */
let OLD: {
  plain: readonly Omit<TextOverlay, 'id'>[]
  merged: readonly Omit<TextOverlay, 'id'>[]
  /** 前の版で保存した(人の修正の入った)タイムライン */
  existing: readonly TextOverlay[]
} | null = null
const chunkOf = (t: Omit<TextOverlay, 'id'>): string => `${t.utteranceId}#${t.utteranceChunk}`
/** 前の版と比べられない既知の型(前の版の「発話+何枚目か」の鍵が指す枚の中身・出し方が今の版と違う) */
const KNOWN_KINDS = [
  'k1-old-key-on-new-chunk',
  'k2-same-chunk-as-old',
  'k3-filler-only-chunk',
  'k4-old-chunk-cut-now',
  'k6-old-auto-same-text'
]
/**
 * 1通りごとに前の版と比べる誤りの種類: 消した言葉が戻る・直した言葉が自動の枚にも出る・言葉が消える・
 * 修正の出る回数が違う(修正が消える・2回出る)・消したはずの修正が残る・同じ言葉が2枚に出る
 */
const WORSE_KINDS = [
  'd-resurrect',
  'd-covered-auto',
  'b-lost',
  'c-edit-count',
  'c-edit-inaudible',
  'h-stale-edit',
  'a-dup'
]
/** 既知の型なら「種類|既知の型」 */
const kn = (known: string | null, raw: string): string => (known ? raw + '|' + known : raw)
function check(
  merged: readonly Omit<TextOverlay, 'id'>[],
  plain: readonly Omit<TextOverlay, 'id'>[],
  m: Model,
  tag: string
): void {
  const judge = (c: string): boolean => !BOTH || BOTH.has(c)
  const audible = new Set(plain.flatMap((t) => kanji(t.text)).filter(judge))
  const count = new Map<string, number>()
  for (const t of merged)
    for (const c of kanji(t.text).filter(judge)) count.set(c, (count.get(c) ?? 0) + 1)
  const covered = new Set([...m.edits.values()].flatMap((s) => [...s]))
  const pc = new Map<string, number>()
  for (const t of plain) for (const c of kanji(t.text)) pc.set(c, (pc.get(c) ?? 0) + 1)
  const plainDup = [...pc].filter(([, n]) => n > 1).map(([c]) => c)
  if (plainDup.length)
    fail(
      'z-plain-dup(plan bug, not merge)',
      `${tag} ${plainDup.join('')} :: ${plain.map((t) => t.text.replace(/\n/g, '')).join(' | ')}`
    )
  for (const c of plainDup) {
    count.delete(c)
    audible.delete(c)
  }
  for (const c of m.ambiguous) audible.delete(c)
  for (const [c, n] of count)
    if (n !== 1)
      fail(
        // 既知の型 1: 前の版の仮編集に無い枚(前の版は出さなかった)に当たった前の版の鍵の修正と重なった
        OLD &&
          merged.some(
            (t) =>
              t.edited &&
              kanji(t.text).includes(c) &&
              !OLD!.plain.some((o) => chunkOf(o) === chunkOf(t))
          )
          ? kn('k1-old-key-on-new-chunk', 'a-dup')
          : 'a-dup',
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
    const heard = [...words].filter((w) => pc.has(w) && judge(w))
    const judged = heard.some((w) => !m.ambiguous.has(w))
    let expected = judged ? 1 : heard.length > 0 || words.size === 0 ? -1 : 0
    // 前の版と比べるとき、今の版だけが出す言葉(前の版が出さなかった言葉)を直した修正は、出る回数を
    // 前の版と比べられない(1 回以下とだけ確かめる)
    if (expected === 0 && [...words].some((w) => pc.has(w) && !judge(w))) expected = -1
    // 漢字の言葉は聞こえなくても、修正した範囲の言いよどみ・かなの切れ端(「と」)が聞こえるなら出てよい
    // (かなは同じ字が何度も出るので、どの言葉かを覚えられない)。その切れ端と同じ時刻に出ているときだけ
    if (expected === 0) {
      const shownAt = merged.filter((t) => t.text === text)
      if (
        shownAt.every((e) =>
          plain.some(
            (q) =>
              q.utteranceId === e.utteranceId &&
              q.startTime < e.endTime - 1e-6 &&
              q.endTime > e.startTime + 1e-6 &&
              /[^\p{Script=Han}\s]/u.test(q.text)
          )
        )
      )
        expected = -1
    }
    // 前の版と比べられない既知の型(前の版の鍵は「発話+何枚目か」だけで、枚全体を受け持つ):
    // 1. 前の版の仮編集に無い枚(頭をカットで落とした枚。前の版は出さなかった)に、前の版の鍵の修正が当たった
    // 2. 前の版のまま作り直しても、同じ修正を同じ枚に出す(今の版は枚のうちカットの中で話す文字だけを出すので、
    //    修正した言葉が聞こえるかの判断だけが前の版と違う)
    // 3. 前の版は修正を出した枚が、今の版では言いよどみの切れ端だけの枚(切れ端を直した修正は出さない)
    // 4. 前の版は修正を出した枚が、今の版の仮編集に無く、その枚の言葉も今の版の仮編集に出ない(今の版は
    //    カットの外の言葉・0.3 秒に満たない枚を出さない。長さ 0 の言葉を辞書で長くした枚など)
    // 6. 前の版も修正を当てていない(見た目だけの修正の文が、前の版の自動の枚の文とたまたま同じで、数えると
    //    出たことになる)。今の版は同じ番号の枚に、そのうちカットの中で話す文字だけを出すので文が違う
    const shownNew = merged.filter((t) => t.text === text)
    const shownOld = OLD ? OLD.merged.filter((t) => t.text === text).map(chunkOf) : []
    const newChunk = (t: Omit<TextOverlay, 'id'>): boolean =>
      !OLD!.plain.some((o) => chunkOf(o) === chunkOf(t))
    // 1 は、前の版の鍵の修正が今の版だけの枚に当たった分を除けば数が合うときも(見た目だけの修正は文が元の
    // 枚の文のままなので、その言葉を出す今の自動の枚も数に入る)
    const onNew = OLD ? shownNew.filter((t) => t.edited && newChunk(t)).length : 0
    const known = !OLD
      ? null
      : n > 0 &&
          (shownNew.every(newChunk) ||
            (onNew > 0 && n - onNew <= Math.max(expected, 0) + Number(expected < 0)))
        ? 'k1-old-key-on-new-chunk'
        : n > 0 && shownNew.every((t) => newChunk(t) || (t.edited && shownOld.includes(chunkOf(t))))
          ? 'k2-same-chunk-as-old'
          : n === 0 &&
              shownOld.length > 0 &&
              shownOld.every((k) =>
                plain.some((p) => chunkOf(p) === k && kanji(p.text).length === 0)
              )
            ? 'k3-filler-only-chunk'
            : n === 0 &&
                shownOld.length > 0 &&
                shownOld.every(
                  (k) =>
                    !plain.some((p) => chunkOf(p) === k) &&
                    OLD!.plain
                      .filter((o) => chunkOf(o) === k)
                      .every((o) => kanji(o.text).every((c) => !pc.has(c)))
                )
              ? 'k4-old-chunk-cut-now'
              : n === 0 &&
                  OLD.merged.some((t) => t.text === text) &&
                  OLD.merged
                    .filter((t) => t.text === text)
                    .every((t) => {
                      if (t.edited) return false
                      const now = plain.filter((p) => chunkOf(p) === chunkOf(t))
                      const was = kanji(t.text)
                      const shown = now.flatMap((p) => kanji(p.text))
                      return (
                        now.length > 0 &&
                        shown.length < was.length &&
                        shown.every((c) => was.includes(c))
                      )
                    })
                ? 'k6-old-auto-same-text'
                : null
    if (expected < 0 ? n > 1 : n !== expected)
      fail(
        kn(known, expected === 0 ? 'c-edit-inaudible' : 'c-edit-count'),
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
        // 既知の型 1: 消した言葉が、今の版だけの枚に当たった前の版の鍵の修正(見た目だけの修正は元の枚の文の
        // まま)の中にだけ出る
        OLD &&
          merged
            .filter((t) => kanji(t.text).includes(c))
            .every(
              (t) =>
                t.edited &&
                !OLD!.existing.some(
                  (x) => x.edited && x.text === t.text && (x as { autoSource?: unknown }).autoSource
                ) &&
                !OLD!.plain.some((o) => chunkOf(o) === chunkOf(t))
            )
          ? kn('k1-old-key-on-new-chunk', 'd-resurrect')
          : 'd-resurrect',
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

const N = Number(process.env.TELOP_MIGRATE_SEEDS ?? 2000)
/**
 * 作り直す回に、直前と同じ場面(カット)のまま1行の文字数だけ変える通りの数(`TELOP_MIGRATE_SAMECUT_SEEDS`。
 * 既定は `TELOP_MIGRATE_SEEDS` の半分)。通常の通りと同じく、1通りごとに 10/09 版のまま作り直した結果より
 * 悪くならないことを確かめる
 */
const N_SAME = Number(process.env.TELOP_MIGRATE_SAMECUT_SEEDS ?? Math.ceil(N / 2))
/**
 * 既定の数より後で見つかった通り(いつも回す)。7153: 別のカットで同じ文の枚が偶然 0.05 秒以内に始まり、
 * 同じタイムラインとみなして前の版の修正を時刻で当て、直した言葉が自動の枚にも出た。7413: 時刻で当てた
 * 修正(延ばした枚)が、覚えておいた前の版の修正の番号の枚まで取り、その修正が消えた。7007: 前の版も
 * 当てていない見た目だけの修正(既知の型 6)。11735・15763: 前の版の鍵の見た目だけの修正が、今の版だけの枚
 * (頭をカットで落とした枚)に当たった(既知の型 1。修正の文は元の枚の文のままなので、その言葉を出す自動の枚・
 * 消した言葉と数が重なる)
 */
// 8354(と同じカットの 1102): 開き直した後の作り直しで、10/09 版の当て方が2枚に出した同じ修正の片方だけを
// 人が直した通り(試験の操作を両方にする)
const FIXED_SEEDS = [7007, 7153, 7413, 8354, 11735, 15763]
/**
 * 同じカットのまま1行の文字数だけ変える通りで、いつも回し、10/09 版の当て方(何枚目か)を今の仮編集に当てた
 * 結果と同じになることも確かめる通り。235・492・494・1331・7048: 第66回の版は 10/09 版の修正を時刻で当て、
 * 消した言葉が戻る・同じ言葉が2回出る・覚えておいた修正が消えた(第66回の監査)。1522・1590・3440・3754:
 * 文が同じ枚の終わりがずれた通り(第66回で見つけた。10/09 版と同じ当て方のままでよい)。7153: 別のカットで
 * 同じ文の枚が偶然近くに始まった通り
 */
const FIXED_SAMECUT_SEEDS = [235, 492, 494, 1102, 1331, 1522, 1590, 3440, 3754, 7048, 7153, 8354]
let SAMECUT = false
/**
 * 開き直して作り直した後に、続けて作り直す回数(`TELOP_MIGRATE_AFTER`。既定 3 = 開き直してから4回作り直す)。
 * 毎回、10/09 版の当て方を今の仮編集に当て続けた結果より悪くならないことを確かめる
 */
const AFTER = Number(process.env.TELOP_MIGRATE_AFTER ?? 3)
/**
 * 開き直した後の作り直しを続ける通りの間隔(`TELOP_MIGRATE_AFTER_EVERY`。既定 2 = 1つおきの通り。CI の時間に
 * 収めるため。決まった通り・1つだけ見る通りはいつも続ける)
 */
const AFTER_EVERY = Math.max(1, Number(process.env.TELOP_MIGRATE_AFTER_EVERY ?? 2))
const ONLY = process.env.TELOP_MIGRATE_SEED ? Number(process.env.TELOP_MIGRATE_SEED) : 0
const seedsFor = (n: number, fixed: number[]): number[] =>
  ONLY ? [ONLY] : [...Array.from({ length: n }, (_, i) => i + 1), ...fixed.filter((x) => x > n)]
async function runMigration(seeds: number[], sameCut: boolean): Promise<void> {
  SAMECUT = sameCut
  pairs.clear()
  const dbg = (...a: unknown[]): void => {
    if (ONLY) console.log(...a)
  }
  let paired = 0
  const worse: string[] = []
  const midWorse: string[] = []
  let fillerExcused = 0
  let afterRuns = 0
  let afterSeeds = 0
  let knownCases = 0
  let knownHid = 0
  /**
   * 今の版の当て直しそのものが 10/09 版の当て方より悪くないか(どちらも今の仮編集に当てて比べる。既知の型を
   * 除かずに比べる。既知の型は、前の版と今の版の仮編集の違い(枚の分け方・出す言葉)から来るものだけのはず)。
   * ただし今の版は、言いよどみの切れ端だけの枚(漢字の無い枚)に当たった修正を出さない(仕様。直した言葉は
   * もう聞こえない)。10/09 版の当て方ではそこにだけ出る修正の、出る回数の違いは比べない。
   * `exact` なら、結果が 10/09 版の当て方と同じになることも確かめる
   */
  const compareMid = (
    seed: number,
    step: number | string,
    mergedNew: readonly Omit<TextOverlay, 'id'>[],
    mergedMid: readonly Omit<TextOverlay, 'id'>[],
    plainNew: readonly Omit<TextOverlay, 'id'>[],
    before: Map<string, number>,
    exact: boolean,
    m: Model,
    /** 誤りの名前の頭(開き直した後の作り直しは 'A'。前の版との合計の比べに入れない) */
    pre = ''
  ): void => {
    const grew = (k: string): number => (pairs.get(k)?.length ?? 0) - (before.get(k) ?? 0)
    const nOf = (ts: readonly Omit<TextOverlay, 'id'>[], text: string): number =>
      ts.filter((t) => t.text === text).length
    const fillerOnly = (text: string): boolean => {
      const at = mergedMid.filter((t) => t.edited && t.text === text)
      return (
        nOf(mergedNew, text) === 0 &&
        at.length > 0 &&
        at.every((t) =>
          plainNew.filter((q) => chunkOf(q) === chunkOf(t)).every((q) => kanji(q.text).length === 0)
        )
      )
    }
    const differ = [...m.edits.keys()].filter(
      (text) => nOf(mergedNew, text) !== nOf(mergedMid, text)
    )
    const fillerEdits = differ.length > 0 && differ.every(fillerOnly)
    // 同じ結果か(10/09 版の当て方は、2枚に分かれた枚に同じ修正を2回出す。今の版は1回にまとめるので、
    // 並んだ同じ修正は1つとみなす。言いよどみの切れ端だけの枚(漢字の無い枚)と、そこに当たった修正は上の
    // とおり比べない)
    if (exact) {
      const fillerChunk = (t: Omit<TextOverlay, 'id'>): boolean =>
        plainNew.filter((q) => chunkOf(q) === chunkOf(t)).every((q) => kanji(q.text).length === 0)
      const flat = (ts: readonly Omit<TextOverlay, 'id'>[]): string =>
        ts
          .filter((t) => (t.edited ? !fillerChunk(t) : kanji(t.text).length > 0))
          .map((t) => (t.edited ? '*' : '') + t.text.replace(/\n/g, ''))
          .filter((x, i, a) => !(x.startsWith('*') && a[i - 1] === x))
          .join(' | ')
      if (flat(mergedNew) !== flat(mergedMid))
        midWorse.push(
          `seed${seed}/step${step} 10/09 版の当て方と違う: 今 ${flat(mergedNew)} / 10/09 版の当て方 ${flat(mergedMid)}`
        )
    }
    if (fillerEdits) fillerExcused++
    WORSE_KINDS.forEach((k) => {
      if (fillerEdits && k.startsWith('c-')) return
      if (grew(`RAW${pre}NEW:` + k) > grew(`RAW${pre}MID:` + k)) {
        const v = pairs.get(`RAW${pre}NEW:` + k)!
        midWorse.push(
          `seed${seed}/step${step} ${k} MID ${grew(`RAW${pre}MID:` + k)} → 今 ${grew(`RAW${pre}NEW:` + k)}: ${v[v.length - 1]}\n      MIDMERGED=${mergedMid.map((t) => (t.edited ? '*' : '') + t.text.replace(/\n/g, '')).join(' | ')}`
        )
      }
    })
  }
  for (const seed of seeds) {
    // 長く続けて回すとテストの作業スレッドが応答できなくなるので、ときどき空ける
    if (seed % 100 === 0) await new Promise((r) => setTimeout(r, 0))
    const r = rng(seed * 7919)
    // 前の版で何回作り直してから開き直すか(1〜5 回)
    SWITCH = 1 + (seed % 5)
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
      OLDNOW = step < SWITCH
      STEP = step
      if (step === SWITCH) {
        paired++
        const ps = Math.floor(r() * 1e9)
        OLDNOW = true
        const plainOld = randomPlan(rng(ps), p, SAMECUT)
        const mergedOld = mergeManualTelops(timeline, plainOld, dismissed, remembered)
        OLDNOW = false
        const plainNew = randomPlan(rng(ps), p, SAMECUT)
        const mergedNew = mergeManualTelops(timeline, plainNew, dismissed, remembered)
        OLDNOW = true
        const mergedMid = mergeManualTelops(timeline, plainNew, dismissed, remembered)
        OLDNOW = false
        if (ONLY) {
          const f2 = (ts: readonly Omit<TextOverlay, 'id'>[]): string =>
            ts
              .map((t) => {
                const a = (
                  t as never as {
                    autoSource?: {
                      start: number
                      end: number
                      times?: number[]
                      offset?: number
                    }
                  }
                ).autoSource
                return `${t.edited ? '*' : ''}${t.text.replace(/\n/g, '/')}[${t.utteranceId}#${t.utteranceChunk} ${t.startTime.toFixed(3)}-${t.endTime.toFixed(3)} src=${a?.start.toFixed(3)}-${a?.end.toFixed(3)} times=${a?.times?.map((x) => x.toFixed(2)).join(',')}]`
              })
              .join('\n    ')
          console.log(
            `PAIRED existing:\n    ${f2(timeline)}\n  plainNew:\n    ${f2(plainNew)}\n  mergedNew:\n    ${f2(mergedNew)}\n  plainOld:\n    ${f2(plainOld)}\n  mergedOld:\n    ${f2(mergedOld)}\n  remembered=${JSON.stringify(remembered)}\n  dismissed=${[...dismissed].join(' ')}`
          )
        }
        PAIRED = true
        {
          const inOld = new Set(plainOld.flatMap((t) => kanji(t.text)))
          BOTH = new Set(plainNew.flatMap((t) => kanji(t.text)).filter((c) => inOld.has(c)))
        }
        const before = new Map([...pairs].map(([k, v]) => [k, v.length]))
        PREFIX = 'OLD:'
        check(mergedOld, plainOld, m, `seed${seed}/step${step}`)
        PREFIX = 'NEW:'
        OLD = { plain: plainOld, merged: mergedOld, existing: timeline }
        check(mergedNew, plainNew, m, `seed${seed}/step${step}`)
        OLD = null
        PREFIX = 'MID:'
        check(mergedMid, plainNew, m, `seed${seed}/step${step}`)
        PAIRED = false
        BOTH = null
        OLD = null
        // この通りで、前の版のまま作り直したより悪くなった誤りの種類(1通りごとに比べる)
        const grew = (k: string): number => (pairs.get(k)?.length ?? 0) - (before.get(k) ?? 0)
        // 既知の型で除いた通り(既知の型を除かずに比べると前の版より悪い通り)の数。中身は上の 10/09 版の当て方
        // との比べで確かめる(除いた誤りが当て直し方から来ていれば、そちらで捕まる)
        if (KNOWN_KINDS.some((k) => grew('NEW:' + k) > 0)) {
          knownCases++
          if (WORSE_KINDS.some((k) => grew('RAWNEW:' + k) > grew('OLD:' + k))) knownHid++
        }
        compareMid(
          seed,
          step,
          mergedNew,
          mergedMid,
          plainNew,
          before,
          sameCut && FIXED_SAMECUT_SEEDS.includes(seed),
          m
        )
        WORSE_KINDS.forEach((k) => {
          const grewNew = grew('NEW:' + k)
          const grewOld = grew('OLD:' + k)
          if (grewNew > grewOld) {
            const v = pairs.get('NEW:' + k)!
            worse.push(
              `seed${seed} ${k} 前の版 ${grewOld} → 今 ${grewNew}: ${v[v.length - 1]}\n      OLDMERGED=${mergedOld.map((t) => (t.edited ? '*' : '') + t.text.replace(/\n/g, '')).join(' | ')}`
            )
          }
        })
        for (const [k, v] of pairs)
          if (k.startsWith('NEW:')) {
            const o = 'OLD:' + k.slice(4)
            const grewNew = v.length - (before.get(k) ?? 0)
            const grewOld = (pairs.get(o)?.length ?? 0) - (before.get(o) ?? 0)
            if (grewNew > 0 && grewOld === 0)
              pairs.set('ONLYNEW:' + k.slice(4), [
                ...(pairs.get('ONLYNEW:' + k.slice(4)) ?? []),
                `${v[v.length - 1]}\n      OLDMERGED=${mergedOld.map((t) => (t.edited ? '*' : '') + t.text.replace(/\n/g, '')).join(' | ')}\n      dismissed=${[...dismissed].join(' ')} remembered=${Object.entries(
                  remembered ?? {}
                )
                  .map(([k2, v2]) => k2 + '=' + v2.text)
                  .join(' ')}`
              ])
          }
        // 開き直した後も、作り直しを続ける(カット・1行の文字数を変えながら、人が直す・消す回を混ぜて)。
        // 毎回、10/09 版の当て方を今の仮編集に当て続けた結果より悪くない。人が開き直した後に何も触っていない間は、
        // 10/09 版の当て方と同じ結果になる(第67回の監査: 1回目の作り直しで 10/09 版の修正だけが範囲を持つ形に
        // 変わり、10/09 版の消した印は何枚目かで効き続けて、2回目以降に消した言葉が戻る・同じ言葉が2回出ていた)
        lastScenes = madeScenes
        const ids = (ts: readonly Omit<TextOverlay, 'id'>[], k: number): TextOverlay[] =>
          ts.map((o, i) => ({ ...o, id: `a${seed}-${k}-${i}` }))
        let now = {
          timeline: ids(mergedNew, 0),
          dismissed: [...dismissed],
          remembered: NM.rememberEditedTelops(timeline, remembered)
        }
        let mid = {
          timeline: ids(mergedMid, 0),
          dismissed: [...dismissed],
          remembered: OM.rememberEditedTelops(timeline, remembered)
        }
        let touched = false
        const after =
          ONLY ||
          seed % AFTER_EVERY === 0 ||
          FIXED_SEEDS.includes(seed) ||
          FIXED_SAMECUT_SEEDS.includes(seed)
            ? AFTER
            : 0
        if (after > 0) afterSeeds++
        for (let k = 1; k <= after; k++) {
          now = saveLoad(now)
          mid = saveLoad(mid)
          const actions = r() < 0.5 ? 0 : 1 + Math.floor(r() * 3)
          for (let a = 0; a < actions && now.timeline.length > 0; a++) {
            const i = Math.floor(r() * now.timeline.length)
            const t = now.timeline[i]
            // 10/09 版の当て方でも同じ枚(同じ発話・番号・文)にだけ、同じ操作をする。10/09 版の当て方は
            // 2枚に分かれた枚に同じ修正を2回出す(鍵も同じ)ので、修正した枚への操作はその全部にする
            // (片方だけ直すと、もう片方の古い文字が同じ鍵で残って当たる)
            const same = mid.timeline
              .map((o, q) =>
                chunkOf(o) === chunkOf(t) && o.text === t.text && !!o.edited === !!t.edited ? q : -1
              )
              .filter((q) => q >= 0)
            const js = new Set(t.edited ? same : same.slice(0, 1))
            const j = same[0]
            const x = r()
            if (j === undefined) continue
            touched = true
            const words = t.edited
              ? (m.edits.get(t.text) ?? new Set<string>())
              : expand(p, kanji(t.text))
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
            dbg(`  after${k} action on ${t.text.replace(/\n/g, '')} x=${x.toFixed(2)}`)
            if (x < 0.45) {
              const text = `E${nextEdit++}` + 'x'.repeat(Math.floor(r() * 30))
              if (t.edited) m.edits.delete(t.text)
              m.edits.set(text, words)
              const patch: Partial<TextOverlay> = { text, edited: true, words: undefined }
              now.timeline[i] = { ...t, ...patch }
              mid.timeline = mid.timeline.map((o, q) => (js.has(q) ? { ...o, ...patch } : o))
            } else if (x < 0.55 && on('style')) {
              if (!t.edited && m.edits.has(t.text)) continue
              if (!t.edited) m.edits.set(t.text, words)
              now.timeline[i] = { ...t, style: { ...t.style, fontSize: 99 }, edited: true }
              mid.timeline = mid.timeline.map((o, q) =>
                js.has(q) ? { ...o, style: { ...o.style, fontSize: 99 }, edited: true } : o
              )
            } else {
              if (t.edited) m.edits.delete(t.text)
              for (const w of words) m.dismissed.add(w)
              now.dismissed.push(NM.autoTelopKey(t)!)
              now.remembered = NM.rememberEditedTelops(now.timeline, now.remembered)
              now.timeline = now.timeline.filter((_, q) => q !== i)
              mid.dismissed.push(OM.autoTelopKey(mid.timeline[j])!)
              mid.remembered = OM.rememberEditedTelops(mid.timeline, mid.remembered)
              mid.timeline = mid.timeline.filter((_, q) => !js.has(q))
            }
          }
          const plan = randomPlan(rng(Math.floor(r() * 1e9)), p, r() < 0.5)
          lastScenes = madeScenes
          const mergedNow = NM.mergeManualTelops(
            now.timeline,
            plan,
            new Set(now.dismissed),
            now.remembered
          )
          const mergedOld = OM.mergeManualTelops(
            mid.timeline,
            plan,
            new Set(mid.dismissed),
            mid.remembered
          )
          dbg(
            `--- after${k}\n  now: ${now.timeline.map((t) => `${t.edited ? '*' : ''}${t.text.replace(/\n/g, '')}[${NM.autoTelopKey(t)}]`).join(' | ')}\n  nowD: ${now.dismissed.join(' ')}\n  nowR: ${Object.entries(
              now.remembered ?? {}
            )
              .map(([q, v]) => q + '=' + v.text)
              .join(
                ' '
              )}\n  mid: ${mid.timeline.map((t) => `${t.edited ? '*' : ''}${t.text.replace(/\n/g, '')}[${OM.autoTelopKey(t)}]`).join(' | ')}\n  midD: ${mid.dismissed.join(' ')}\n  plan: ${plan.map((t) => `${t.text.replace(/\n/g, '')}[${NM.autoTelopKey(t as never)}]`).join(' | ')}\n  gotNow: ${mergedNow.map((t) => `${t.edited ? '*' : ''}${t.text.replace(/\n/g, '')}`).join(' | ')}\n  gotMid: ${mergedOld.map((t) => `${t.edited ? '*' : ''}${t.text.replace(/\n/g, '')}`).join(' | ')}\n  model: edits=${[...m.edits].map(([q, v]) => q + ':' + [...v].join('')).join(' ')} dismissed=${[...m.dismissed].join('')}`
          )
          const before = new Map([...pairs].map(([key, v]) => [key, v.length]))
          PAIRED = true
          PREFIX = 'ANEW:'
          check(mergedNow, plan, m, `seed${seed}/step${step}+${k}`)
          PREFIX = 'AMID:'
          check(mergedOld, plan, m, `seed${seed}/step${step}+${k}`)
          PAIRED = false
          compareMid(
            seed,
            `${step}+${k}${touched ? '(人の操作の後)' : ''}`,
            mergedNow,
            mergedOld,
            plan,
            before,
            !touched,
            m,
            'A'
          )
          afterRuns++
          now = {
            timeline: ids(mergedNow, k),
            dismissed: now.dismissed,
            remembered: NM.rememberEditedTelops(now.timeline, now.remembered)
          }
          mid = {
            timeline: ids(mergedOld, k),
            dismissed: mid.dismissed,
            remembered: OM.rememberEditedTelops(mid.timeline, mid.remembered)
          }
        }
        break
      }
      const plain = randomPlan(r, p)
      lastScenes = madeScenes
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
            const whole = to.every((c) => shownChars.has(c)) || from.every((c) => shownChars.has(c))
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
  // 前の版で保存した企画を開き直した作り直しで、前の版のまま作り直したときより悪くならない
  const total = (k: string): number => pairs.get(k)?.length ?? 0
  const kinds = ['d-resurrect', 'b-lost', 'c-edit-count']
  const report = kinds.map((k) => `${k}: 前の版 ${total('OLD:' + k)} → 今 ${total('NEW:' + k)}`)
  if (process.env.TELOP_MIGRATE_REPORT)
    console.log(
      [...report, ...kinds.flatMap((k) => (pairs.get('ONLYNEW:' + k) ?? []).slice(0, 3))].join('\n')
    )
  // 合計だけでなく、1通りごとに前の版のまま作り直したより悪くならない(合計では、ある通りで良くなった分が
  // 別の通りで悪くなった分を隠す)
  if (worse.length > 0)
    console.log(
      `${worse.length} 通りで悪くなった\n${worse.slice(0, process.env.TELOP_MIGRATE_REPORT ? undefined : 10).join('\n')}`
    )
  if (midWorse.length > 0)
    console.log(
      `10/09 版の当て方より悪い ${midWorse.length} 通り\n${midWorse.slice(0, process.env.TELOP_MIGRATE_REPORT ? undefined : 10).join('\n')}`
    )
  expect(worse.slice(0, 5)).toEqual([])
  expect(midWorse.slice(0, 5)).toEqual([])
  if (!sameCut)
    for (const k of kinds)
      expect(total('NEW:' + k), report.join(' / ')).toBeLessThanOrEqual(total('OLD:' + k))
  if (process.env.TELOP_MIGRATE_REPORT)
    console.log(
      `既知の型(前の版と比べない): ${KNOWN_KINDS.map((k) => `${k} ${pairs.get('NEW:' + k)?.length ?? 0} 件`).join(' / ')}\n` +
        `既知の型の出た通り ${knownCases} / うち除かなければ前の版より悪い通り ${knownHid} / ` +
        `言いよどみの切れ端の修正で 10/09 版の当て方と回数を比べなかった通り ${fillerExcused}`
    )
  expect(paired).toBe(seeds.length)
  expect(afterRuns).toBe(afterSeeds * AFTER)
  expect(afterSeeds).toBeGreaterThanOrEqual(Math.floor(seeds.length / AFTER_EVERY))
}
describe('前の版(c25f5af)で保存した企画の作り直し(辞書・長さ 0 の言葉・相づち)', () => {
  it(
    '前の版のまま作り直すより、消したものが戻る・言葉が消える・修正の回数の誤りが増えない',
    () => runMigration(seedsFor(N, FIXED_SEEDS), false),
    Math.max(120000, N * 1000)
  )
  it(
    '作り直す回に同じカットのまま1行の文字数だけ変えても、前の版のまま作り直すより悪くならない',
    () => runMigration(seedsFor(N_SAME, FIXED_SAMECUT_SEEDS), true),
    Math.max(120000, N_SAME * 1000)
  )
})

/**
 * 第63回の監査 1: 短い枚を隣の枚にまとめると枚が「何枚目か」が変わり、前の版(c25f5af)で「発話+何枚目か」の
 * 鍵で消した・直した枚が作り直すと戻った(消した文字が出る・直した「★」が消える)。前の版のまま作り直した
 * 結果と同じになること
 */
describe('前の版で消した・直した枚(監査の再現)', () => {
  const words = [
    { text: '一七丆', start: 0.48, end: 0.48 },
    { text: '三', start: 0.7, end: 1.035 },
    { text: '丌', start: 1.31, end: 1.37 }
  ]
  const dict = [{ from: '一七丆', to: '言訁訂訃訄訅訆訇計訉訊訋訌訍' }]
  const project = {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [],
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    transcript: [
      {
        id: 'u0',
        assetId: 'MA',
        speaker: 'A',
        sourceStart: 0.48,
        sourceEnd: 1.37,
        text: '一七丆三丌',
        words,
        overlap: false
      }
    ],
    multicam: info
  } as unknown as Project
  const activity = new Uint8Array(400 * TURN_RATE).fill(1, 0, 4 * TURN_RATE)
  const scenes = [{ id: 's0', start: 0, end: 4, lines: [], speech: 0 }]
  const planWith = (old: boolean): TextOverlay[] =>
    (
      (old ? OP.planRoughCut : NP.planRoughCut) as (...x: unknown[]) => {
        telops: Omit<TextOverlay, 'id'>[]
      }
    )(
      project,
      info,
      scenes,
      [{ sceneId: 's0', score: 100, kind: 'highlight' as const, reason: '' }],
      activity,
      {
        targetSec: 0,
        keep: { s0: true },
        styles: [],
        speechLook: { style: defaultTextStyle() },
        kind: 'game',
        policy: 'light',
        dictionary: dict,
        style: { telopLineChars: 7 } as never
      }
    ).telops.map((t, i) => ({ ...t, id: `t${i}` }))
  const flatText = (ts: readonly Omit<TextOverlay, 'id'>[]): string =>
    ts.map((t) => (t.edited ? `[${t.text}]` : t.text.replace(/\s/g, ''))).join(' | ')
  const saved = planWith(true)

  it('前の版の枚の分け方(監査の前提)', () => {
    expect(flatText(saved)).toBe('言訁訂訃訄訅訆訇計訉訊 | 訋訌訍三丌')
  })

  it('1枚目を消して作り直しても、消した文字は出ない', () => {
    const dismissed = new Set([NM.autoTelopKey(saved[0])!])
    const timeline = saved.slice(1)
    const want = OM.mergeManualTelops(timeline, planWith(true), dismissed)
    const got = NM.mergeManualTelops(timeline, planWith(false), dismissed)
    expect(flatText(got)).toBe(flatText(want))
    expect(flatText(got)).not.toMatch(/[言訁訂訃訄訅訆訇計訉訊]/)
  })

  // 今の版では1枚目(長さ 0 の言葉を辞書で長くした枚)が 0.01 秒ほどしかなく出ないので、それを直した「★」も
  // 出ない(0.3 秒未満の枚は出さない既知の制限。前の版はこの枚を出したので「★」が出る)。直した枚の文字が
  // 自動の枚で戻らず、ほかの枚がそのままであることを確かめる
  it('1枚目を「★」に直して作り直しても、直した文字は戻らず、ほかの枚はそのまま', () => {
    const timeline = saved.map((t, i) => (i === 0 ? { ...t, text: '★', edited: true } : t))
    const got = NM.mergeManualTelops(
      timeline,
      planWith(false),
      new Set(),
      NM.rememberEditedTelops(timeline, undefined)
    )
    expect(flatText(got.filter((t) => !t.edited))).toBe('訋訌訍三丌')
    expect(got.filter((t) => t.text === '★').length).toBeLessThanOrEqual(1)
  })
})

/**
 * 第66回の監査 1: 10/09 版の企画を同じカットのまま1行の文字数だけ変えて作り直すと、10/09 版の修正を時刻
 * (10/09 版で延ばした枚の範囲。話した時刻ではない)で当て、10/09 版の消した印は何枚目かでしか効かないので、
 * 消した言葉が戻る・同じ言葉が2回出ていた。10/09 版の修正は 10/09 版と同じく何枚目かで当て、10/09 版のまま
 * 作り直した結果と同じになること
 */
describe('10/09 版の修正・消した印を、同じカットで1行の文字数だけ変えて当て直す(第66回の監査)', () => {
  const style = defaultTextStyle()
  const looked = { ...style, fontSize: 99 }
  /** 10/09 版で保存した枚(元の部分を覚えていない) */
  const saved = (
    utteranceChunk: number,
    text: string,
    startTime: number,
    endTime: number,
    edited = false
  ): TextOverlay => ({
    id: `o${utteranceChunk}`,
    text,
    startTime,
    endTime,
    style: edited ? looked : style,
    speaker: 'A',
    source: 'auto',
    utteranceId: 'u',
    utteranceChunk,
    ...(edited ? { edited: true } : {})
  })
  /** 今の仮編集の枚(文字ごとの話した時刻を持つ) */
  const fresh = (
    utteranceChunk: number,
    text: string,
    startTime: number,
    endTime: number,
    times: number[]
  ): Omit<TextOverlay, 'id'> =>
    ({
      text,
      startTime,
      endTime,
      style,
      speaker: 'A',
      source: 'auto',
      utteranceId: 'u',
      utteranceChunk,
      autoSource: { start: startTime, end: endTime, text, times, offset: 0 }
    }) as Omit<TextOverlay, 'id'>
  const flat = (ts: readonly Omit<TextOverlay, 'id'>[]): string =>
    ts.map((t) => (t.edited ? '*' : '') + t.text).join(' | ')
  const both = (
    existing: TextOverlay[],
    incoming: Omit<TextOverlay, 'id'>[],
    dismissed: string[]
  ): { got: string; want: string } => {
    const remembered = NM.rememberEditedTelops(existing, undefined)
    return {
      got: flat(NM.mergeManualTelops(existing, incoming, new Set(dismissed), remembered)),
      want: flat(OM.mergeManualTelops(existing, incoming, new Set(dismissed), remembered))
    }
  }

  it('例1: 修正した枚の次の枚を消してあっても、消した言葉が戻らない', () => {
    const { got, want } = both(
      [saved(0, '一二', 0, 1), saved(1, '三四', 1.5, 2.5, true)],
      [fresh(0, '一二', 0, 1.5, [0.3, 0.9]), fresh(1, '三四五六', 1.5, 3.5, [1.7, 2.2, 2.7, 3.2])],
      ['u:u#2']
    )
    expect(want).toBe('一二 | *三四')
    expect(got).toBe(want)
  })

  // 第65回の版は、ほかの枚が頭も終わりもそろうと同じタイムラインとみなし、10/09 版の修正を時刻で当てていた
  it('例1 で直していない枚がそろっていても、消した言葉が戻らない', () => {
    const { got, want } = both(
      [saved(0, '一二', 0, 1), saved(1, '三四', 1.5, 2.5, true)],
      [fresh(0, '一二', 0, 1, [0.3, 0.7]), fresh(1, '三四五六', 1.5, 3.5, [1.7, 2.2, 2.7, 3.2])],
      ['u:u#2']
    )
    expect(want).toBe('一二 | *三四')
    expect(got).toBe(want)
  })

  it('例2: 見た目だけの修正の言葉が、自動の枚と2回出ない', () => {
    const { got, want } = both(
      [saved(0, '一二', 0, 2), saved(1, '三四', 2, 3, true)],
      [fresh(0, '一二', 0, 1.2, [0.3, 0.9]), fresh(1, '三四', 1.2, 3, [1.6, 2.5])],
      []
    )
    expect(want).toBe('一二 | *三四')
    expect(got).toBe(want)
  })
})

/**
 * 第67回の監査: 10/09 版の修正は作り直し1回目で範囲を持つ形に変わり、10/09 版の消した印(何枚目かだけ)は
 * その後も何枚目かで効くので、2回目以降の作り直しで消した言葉が戻る・同じ言葉が2回出ていた。10/09 版の
 * 企画から来た印は、人が新しく触るまで何回作り直しても 10/09 版と同じく何枚目かで当て、10/09 版のまま
 * 作り直し続けた結果と同じになること(1文字1秒の枚)
 */
describe('10/09 版の修正・消した印を、何回作り直しても何枚目かで当てる(第67回の監査)', () => {
  const style = defaultTextStyle()
  const looked = { ...style, fontSize: 99 }
  const saved = (
    utteranceChunk: number,
    text: string,
    startTime: number,
    endTime: number,
    edited = false
  ): TextOverlay => ({
    id: `o${utteranceChunk}`,
    text,
    startTime,
    endTime,
    style: edited ? looked : style,
    speaker: 'A',
    source: 'auto',
    utteranceId: 'u',
    utteranceChunk,
    ...(edited ? { edited: true } : {})
  })
  /** 今の仮編集: 文を枚ごとに分けた並び(1文字1秒、頭は 0 秒) */
  const plan = (...texts: string[]): Omit<TextOverlay, 'id'>[] => {
    let t = 0
    return texts.map((text, utteranceChunk) => {
      const startTime = t
      const times = [...text].map((_, k) => t + k + 0.5)
      t += [...text].length
      return {
        text,
        startTime,
        endTime: t,
        style,
        speaker: 'A',
        source: 'auto',
        utteranceId: 'u',
        utteranceChunk,
        autoSource: { start: startTime, end: t, text, times, offset: 0 }
      } as Omit<TextOverlay, 'id'>
    })
  }
  const flat = (ts: readonly Omit<TextOverlay, 'id'>[]): string =>
    ts.map((t) => (t.edited ? '*' : '') + t.text).join(' | ')
  type Lib = typeof NM | typeof OM
  /** 同じ仮編集の並びで作り直し続け(保存と読み込みを挟む)、毎回の結果 */
  const chain = (
    lib: Lib,
    start: TextOverlay[],
    dismissedKeys: string[],
    plans: Omit<TextOverlay, 'id'>[][],
    /** 作り直しの前に人がする操作(文がこの文の枚を直す・消す) */
    touch: Record<number, { text: string; to?: string }> = {}
  ): string[] => {
    let timeline = start
    let remembered: Record<string, EditedTelop> | undefined
    const dismissed = new Set(dismissedKeys)
    return plans.map((incoming, step) => {
      const op = touch[step]
      if (op) {
        const i = timeline.findIndex((o) => o.text === op.text)
        expect(i).toBeGreaterThanOrEqual(0)
        if (op.to !== undefined)
          timeline[i] = { ...timeline[i], text: op.to, edited: true, words: undefined }
        else {
          dismissed.add(lib.autoTelopKey(timeline[i])!)
          remembered = (lib.rememberEditedTelops as typeof NM.rememberEditedTelops)(
            timeline,
            remembered
          )
          timeline = timeline.filter((_, k) => k !== i)
        }
      }
      const merged = (lib.mergeManualTelops as typeof NM.mergeManualTelops)(
        timeline,
        incoming,
        dismissed,
        remembered
      )
      remembered = (lib.rememberEditedTelops as typeof NM.rememberEditedTelops)(
        timeline,
        remembered
      )
      ;({ timeline, remembered } = saveLoad({
        timeline: merged.map((o, i) => ({ ...o, id: `r${step}-${i}` })),
        remembered
      }))
      return flat(merged)
    })
  }

  it('A: 直した枚の隣の枚を消してあっても、2回目以降の作り直しで消した言葉が戻らない', () => {
    const start = [saved(0, 'E0', 0, 3, true), saved(2, '七八', 6, 8)]
    const plans = [
      plan('一二三', '四五六', '七八'),
      plan('一二三四五', '六七八'),
      plan('一二', '三四五六', '七八'),
      plan('一二三四五', '六七八')
    ]
    const want = chain(OM, start, ['u:u#1'], plans)
    const got = chain(NM, start, ['u:u#1'], plans)
    expect(want.slice(0, 2)).toEqual(['*E0 | 七八', '*E0'])
    expect(got).toEqual(want)
  })

  it('A で人が後から別の枚を直す・消しても、10/09 版のまま作り直し続けた結果と同じ', () => {
    const start = [saved(0, 'E0', 0, 3, true), saved(2, '七八', 6, 8)]
    const plans = [
      plan('一二三', '四五六', '七八'),
      plan('一二三四五', '六七八'),
      plan('一二', '三四五六', '七八'),
      plan('一二三四五', '六七八'),
      plan('一二三', '四五六', '七八')
    ]
    const touch = { 1: { text: '七八', to: 'F' }, 3: { text: 'E0' } }
    const want = chain(OM, start, ['u:u#1'], plans, touch)
    const got = chain(NM, start, ['u:u#1'], plans, touch)
    expect(want).toEqual(['*E0 | 七八', '*E0', '*E0 | *F', '', '*F'])
    expect(got).toEqual(want)
    // 10/09 版の印のある発話の枚は、元の部分を持たない(人が新しく触っても何枚目かの鍵で覚える)
    const out = NM.mergeManualTelops([], plan('一二', '三四'), new Set(['u:u#1']), {})
    expect(out.map((t) => NM.autoTelopKey(t))).toEqual(['u:u#0'])
  })

  it('B: 見た目だけの修正が、2回目以降の作り直しで自動の枚と2回出ない', () => {
    const start = [saved(0, '一二三四', 0, 4, true), saved(1, '五六', 4, 6)]
    const plans = [
      plan('一二', '三四', '五六'),
      plan('一二三四', '五六'),
      plan('一二', '三四', '五六')
    ]
    const want = chain(OM, start, [], plans)
    const got = chain(NM, start, [], plans)
    expect(want.slice(0, 2)).toEqual(['*一二三四 | 三四 | 五六', '*一二三四 | 五六'])
    expect(got).toEqual(want)
  })
})

/**
 * 第69回の監査: 10/09 版の何枚目かだけの印がある発話で、自動編集の画面の「文字起こしからテロップ」で並べた枚に
 * 元の部分が付き、その枚を消す・直すと範囲つきの印が何枚目かの古い印と混ざって、作り直すと 10/09 版で消した
 * 言葉が戻っていた。その発話は並べた枚にも元の部分を付けず(作り直しと同じ判定)、10/09 版より悪くならないこと
 */
describe('10/09 版の印のある発話を、文字起こしから並べ直して消す・直す(第69回の監査)', () => {
  type Auto = Omit<TextOverlay, 'id'>
  const look = { style: defaultTextStyle() }
  /** 10/09 版(c25f5af)の「文字起こしからテロップ」(元の部分を付けない) */
  const arrangeOld = (project: Project, lineChars: number, dict: Gen['dict']): Auto[] => {
    const clips = placedClips(project)
    const out: Auto[] = []
    for (const u of project.transcript ?? []) {
      const chunks = OF.utteranceToTelopChunks(u, {
        dictionary: dict,
        maxLineChars: lineChars,
        minDurationSec: 1
      })
      for (const [ci, chunk] of chunks.entries()) {
        const r = utteranceTimelineRange(
          { assetId: u.assetId, sourceStart: chunk.sourceStart, sourceEnd: chunk.sourceEnd },
          clips
        )
        if (!r || r.end - r.start < 0.2) continue
        out.push({
          text: chunk.text,
          startTime: r.start,
          endTime: r.end,
          style: speechTelopStyle(look.style),
          speaker: u.speaker,
          source: 'auto',
          utteranceId: u.id,
          utteranceChunk: ci
        })
      }
    }
    const settled = OF.settleTelopTimes(out, mainHardCuts(project))
    return stackSimultaneousTelops(settled, textCanvasSize(project.aspectRatio).h)
  }
  const arrangeNew = (project: Project, lineChars: number, dict: Gen['dict']): Auto[] =>
    telopsFromTranscript(project, [], dict, { lineChars, minSec: 1 }, look)
  /** 10/09 版と同じく元の部分を持たない枚 */
  const withoutSource = (t: Auto): Auto => {
    const c = { ...t } as Auto & { autoSource?: unknown }
    delete c.autoSource
    return c
  }
  /** マイクの音声トラックだけの企画(速さを変えたクリップ) */
  const withAudio = (base: Project, speed: number): Project =>
    ({
      ...base,
      audioTracks: [
        {
          id: 'at',
          name: 'A',
          muted: false,
          volume: 1,
          duckingEnabled: false,
          clips: [{ id: 'ac', assetId: 'MA', startTime: 0, inPoint: 0, outPoint: 400, speed }]
        }
      ]
    }) as unknown as Project
  const planWith = (old: boolean, p: Gen, scenes: Scene[], lineChars: number): Auto[] =>
    ((old ? OP.planRoughCut : NP.planRoughCut) as (...x: unknown[]) => { telops: Auto[] })(
      p.project,
      info,
      scenes,
      scenes.map((s) => ({ sceneId: s.id, score: 100, kind: 'highlight' as const, reason: '' })),
      p.activity,
      {
        targetSec: 0,
        keep: Object.fromEntries(scenes.map((s) => [s.id, true])),
        styles: [],
        speechLook: look,
        kind: 'game',
        policy: 'light',
        dictionary: p.dict,
        style: { telopLineChars: lineChars } as never
      }
    ).telops
  interface State {
    timeline: TextOverlay[]
    dismissed: string[]
    edited?: Record<string, EditedTelop>
    /** 人が消した・直した枚の言葉(作り直しても自動の枚に出てはいけない) */
    gone: Set<string>
  }
  type Lib = typeof NM | typeof OM
  /** 人が枚を消す・直す(`removeTextOverlay`・`updateTextOverlay` と同じ印) */
  const touch = (
    lib: Lib,
    st: State,
    pick: (o: TextOverlay, i: number) => 'del' | 'edit' | null
  ): State => {
    const timeline: TextOverlay[] = []
    const dismissed = [...st.dismissed]
    const gone = new Set(st.gone)
    st.timeline.forEach((o, i) => {
      const op = o.edited ? null : pick(o, i)
      if (op) for (const c of kanji(o.text)) gone.add(c)
      if (op === 'del') {
        const k = lib.autoTelopKey(o as never)
        if (k && !dismissed.includes(k)) dismissed.push(k)
      } else if (op === 'edit') timeline.push({ ...o, text: `★${i}`, edited: true })
      else timeline.push(o)
    })
    return { ...st, timeline, dismissed, gone }
  }
  /** 仮編集の作り直し(`applyRoughCut` と同じ順) */
  const rebuild = (lib: Lib, st: State, telops: Auto[], tag: string): State => {
    const remember = lib.rememberEditedTelops as typeof NM.rememberEditedTelops
    const merge = lib.mergeManualTelops as typeof NM.mergeManualTelops
    const edited = remember(st.timeline, st.edited)
    const merged = merge(st.timeline, telops, new Set(st.dismissed), st.edited)
    // 保存と読み込みを挟む
    return {
      ...saveLoad({
        dismissed: st.dismissed,
        edited,
        timeline: [
          ...st.timeline.filter((o) => !o.utteranceId && !o.effectId),
          ...merged.map((o, i) => ({ ...o, id: `${tag}-${i}` }))
        ]
      }),
      gone: st.gone
    }
  }
  /** 文字起こしから並べる(`addTextOverlays`) */
  const arrange = (st: State, telops: Auto[], tag: string): State => ({
    ...st,
    timeline: [...st.timeline, ...telops.map((o, i) => ({ ...o, id: `${tag}-${i}` }))]
  })
  const projectOf = (p: Gen, st: State, speed: number): Project => ({
    ...withAudio(p.project, speed),
    textOverlays: st.timeline,
    dismissedTelops: st.dismissed,
    editedTelops: st.edited
  })
  /** 自動の枚に出た、人が消した・直した言葉と、2回出た言葉 */
  const errors = (st: State): string[] => {
    const count = new Map<string, number>()
    for (const t of st.timeline.filter((o) => !o.edited))
      for (const c of kanji(t.text)) count.set(c, (count.get(c) ?? 0) + 1)
    return [...count].flatMap(([c, n]) => [
      ...(st.gone.has(c) ? [`戻った「${c}」`] : []),
      ...(n > 1 ? [`${n}回「${c}」`] : [])
    ])
  }

  /**
   * 1通り: 10/09 版の時代に並べて(作り直して)消す・直す → 開き直して並べ直し、消す・直す → 2回作り直す。
   * 開き直した後の「文字起こしからテロップ」を 10/09 版と同じく元の部分の無い枚で並べた結果(第69回より前・
   * 10/09 版と同じ当て方)と、今の版で並べた結果の誤り(人の操作は同じ。仮編集・合わせ方は今の版)
   */
  const runSeed = (seed: number): { old: string[]; now: string[] } => {
    const r = rng(seed)
    const p = makeProject(r)
    const speed = r() < 0.5 ? 1 : [0.75, 1.25, 1.5][Math.floor(r() * 3)]
    const cut = (): Scene[] => {
      const n = 1 + Math.floor(r() * 3)
      const cuts = Array.from({ length: n * 2 }, () => r() * p.total).sort((a, b) => a - b)
      return Array.from({ length: n }, (_, i) => ({
        id: `s${i}`,
        start: cuts[i * 2],
        end: Math.max(cuts[i * 2] + 0.5, cuts[i * 2 + 1]),
        lines: [] as never[],
        speech: 0
      }))
    }
    const lc = (): number => 4 + Math.floor(r() * 12)
    const act = (o: TextOverlay, i: number, rr: () => number): 'del' | 'edit' | null => {
      void o
      void i
      const x = rr()
      return x < 0.25 ? 'del' : x < 0.37 ? 'edit' : null
    }
    // 10/09 版の時代(どちらも同じ)
    let st: State = { timeline: [], dismissed: [], gone: new Set() }
    st = arrange(st, arrangeOld(withAudio(p.project, speed), lc(), p.dict), 'a0')
    st = touch(OM, st, (o, i) => act(o, i, r))
    if (r() < 0.5) {
      st = rebuild(OM, st, planWith(true, p, cut(), lc()), 'b0')
      st = touch(OM, st, (o, i) => act(o, i, r))
    }
    st = {
      ...saveLoad({ timeline: st.timeline, dismissed: st.dismissed, edited: st.edited }),
      gone: st.gone
    }
    // 開き直した後(同じ乱数の並びで、10/09 版のまま・今の版の両方)
    const lc1 = lc()
    const cut1 = cut()
    const lc2 = lc()
    const cut2 = r() < 0.5 ? cut1 : cut()
    const lc3 = lc()
    const after = r() * 1e9
    const go = (asOf1009: boolean): string[] => {
      const rr = rng(after)
      let s: State = { ...st, gone: new Set(st.gone) }
      const arranged = arrangeNew(projectOf(p, s, speed), lc1, p.dict)
      s = arrange(s, asOf1009 ? arranged.map(withoutSource) : arranged, 'a1')
      const fresh = new Set(s.timeline.slice(st.timeline.length).map((o) => o.id))
      s = touch(NM, s, (o, i) => (fresh.has(o.id) ? act(o, i, rr) : null))
      s = rebuild(NM, s, planWith(false, p, cut1, lc2), 'b1')
      s = rebuild(NM, s, planWith(false, p, cut2, lc3), 'b2')
      return errors(s)
    }
    return { old: go(true), now: go(false) }
  }

  it('監査の再現: 並べ直した1枚目を消して作り直しても、10/09 版で消した後ろ半分は出ない', () => {
    const words = Array.from({ length: 14 }, (_, k) => ({
      text: String.fromCodePoint(0x4e00 + k * 3),
      start: 1 + k * 0.3,
      end: 1.25 + k * 0.3
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
      transcript: [
        {
          id: 'u0',
          assetId: 'MA',
          speaker: 'A',
          sourceStart: words[0].start,
          sourceEnd: words[13].end,
          text: words.map((w) => w.text).join(''),
          words,
          overlap: false
        }
      ],
      multicam: info
    } as unknown as Project
    const p: Gen = {
      project,
      total: 6,
      activity: new Uint8Array(400 * TURN_RATE).fill(1, TURN_RATE, 6 * TURN_RATE),
      dict: [],
      atom: new Map()
    }
    const scenes: Scene[] = [{ id: 's0', start: 0, end: 6, lines: [], speech: 0 }]
    const start: State = {
      timeline: [],
      dismissed: ['u:u0#1'],
      gone: new Set(kanji('丕丘丛丞両两丧'))
    }
    const go = (old: boolean): string => {
      const lib = old ? OM : NM
      const proj = projectOf(p, start, 1)
      let s = arrange(start, old ? arrangeOld(proj, 5, []) : arrangeNew(proj, 5, []), 'a')
      expect(s.timeline.map((o) => o.text.replace(/\s/g, ''))).toEqual([
        '一七丆三丌丏丒',
        '丕丘丛丞両两丧'
      ])
      s = touch(lib, s, (_, i) => (i === 0 ? 'del' : null))
      s = rebuild(lib, s, planWith(old, p, scenes, 12), 'b')
      return s.timeline.map((o) => o.text.replace(/\s/g, '')).join(' | ')
    }
    expect(go(true)).toBe('')
    expect(go(false)).toBe('')
  })

  const SEEDS = Number(process.env.TELOP_ARRANGE_SEEDS ?? 600)
  it(
    '乱択: 10/09 版のまま続けるより、消した・直した言葉が戻る・2回出る通りが増えない',
    () => {
      const worse: string[] = []
      for (let seed = 1; seed <= SEEDS; seed++) {
        const { old, now } = runSeed(seed)
        if (now.length > old.length)
          worse.push(`#${seed} 今: ${now.join(' ')} / 10/09 版: ${old.join(' ')}`)
      }
      expect(worse, worse.slice(0, 5).join('\n')).toEqual([])
    },
    Math.max(120000, SEEDS * 400)
  )
})

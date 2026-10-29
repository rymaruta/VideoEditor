import { describe, expect, it } from 'vitest'
import {
  applySceneMoves,
  boundaryCandidates,
  controlGaps,
  endsOpen,
  MAX_SHIFT_LINES,
  MAX_SHIFT_SEC,
  MIN_GAP_SEC,
  parseGapAnswer,
  planSceneMoves,
  suspectBoundaries,
  type AskJson,
  type SceneMove
} from '../../src/shared/structure/boundaryAi'
import { buildScenes, type Scene, type TimedLine } from '../../src/shared/structure/scenes'
import { KIND_PROFILES } from '../../src/shared/structure/kind'
import * as old from './fixtures/scenesF0f27f36'
import { TRIAL4_TRANSCRIPT } from './fixtures/trial4Transcript'
import {
  matchScenesAcrossMoves,
  matchScenesByTime,
  remapSceneFlags
} from '../../src/renderer/src/lib/pipelineRestore'
import type { LlmRequest } from '../../src/shared/llm'

/**
 * 場面の区切りの AI による直し(足し算の後段)。LLM は偽物。
 * - AI が使えない・答えが壊れている・2通りの答えが食い違う(位置に寄った答え)ときは、公開中の版(0f27f36)と
 *   完全に同じ区切り
 * - 動かすのは発話の間(前後 3 発話・30 秒以内)だけ、場面の長さの上限・下限を守る、発話を落とさない
 * - 第4回 N4(文の途中から始まる 9 秒の場面): 話の途中と答えれば前の場面へ入れる
 * - 保存した直しで開き直すと、作った時と同じ区切り。人の残す/落とすは覆らない
 */

const fromRows = (rows: readonly (readonly [number, number, string])[]): TimedLine[] =>
  rows.map(([start, end, text], i) => ({
    id: `u${i}`,
    speaker: 'マイク1',
    start,
    end,
    text,
    overlap: false
  }))
const TRIAL4 = fromRows(TRIAL4_TRANSCRIPT)
const RANGE = { start: 0, end: 660 }

const rng = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const TEXTS = [
  'それで現場ではいろいろな工夫をしてきまして',
  'やはり思い切って価格を上げたというのは',
  'どういった背景から可能となったのか',
  'ぜひお聞かせいただきたいなと思います',
  '私どもでは採用の方法を変えました',
  'あとやはり我々は',
  '一緒に頑張っていこうという形で',
  'こんにちは',
  'すごい!',
  'ありがとうございました'
]
function synthetic(seed: number): { lines: TimedLine[]; end: number } {
  const r = rng(seed)
  const lines: TimedLine[] = []
  let t = r() * 5
  const length = 300 + r() * 1200
  while (t < length) {
    const d = 0.5 + r() * 8
    lines.push({
      id: `l${lines.length}`,
      speaker: r() < 0.5 ? 'A' : 'B',
      start: t,
      end: t + d,
      text: TEXTS[Math.floor(r() * TEXTS.length)],
      overlap: false
    })
    const x = r()
    t +=
      d +
      (x < 0.6 ? 0.05 + r() * 0.9 : x < 0.8 ? 1 + r() * 3 : x < 0.95 ? 4 + r() * 4 : 8 + r() * 20)
  }
  return { lines, end: t + r() * 15 }
}
const CORPORA = [
  { name: '第4回', lines: TRIAL4, end: 660 },
  ...Array.from({ length: 60 }, (_, i) => ({ name: `合成 ${i + 1}`, ...synthetic(i + 1) }))
]
const OPTIONS = [KIND_PROFILES.location.scene, KIND_PROFILES.game.scene]

/** 頼みの文の「ここ」の直前の発話の文 */
function tailBefore(prompt: string): string {
  const head = prompt.split('──── ここ ────')[0]
  const all = [...head.matchAll(/「([^「」]*)」/gu)]
  return all.length > 0 ? all[all.length - 1][1].replace(/^…/u, '') : ''
}
const enumOf = (r: LlmRequest): string[] =>
  ((r.schema.properties as Record<string, { enum: string[] }>).answer.enum as string[]) ?? []

/** 中身を見て答える偽物: `continues(直前の発話)` が真なら「話の途中」 */
function oracle(continues: (tail: string) => boolean): AskJson & { calls: LlmRequest[][] } {
  const calls: LlmRequest[][] = []
  const ask = (async (requests: LlmRequest[]) => {
    calls.push(requests)
    return requests.map((r) => ({
      reason: '',
      answer: continues(tailBefore(r.prompt)) ? '話の途中' : '話の切れ目'
    }))
  }) as AskJson & { calls: LlmRequest[][] }
  ask.calls = calls
  return ask
}
/** 中身によらず、先に書いた言葉を選ぶ偽物(小さいモデルの答え方) */
const firstChoice: AskJson = async (requests) =>
  requests.map((r) => ({ reason: 'A', answer: enumOf(r)[0] }))
/** 何でも「話の途中」(向きを逆にしても同じ言葉を選ぶ偽物) */
const alwaysContinues = oracle(() => true)
/** 答えが壊れている */
const broken: AskJson[] = [
  async (r) => r.map(() => null),
  async (r) => r.map(() => ({})),
  async (r) => r.map(() => ({ answer: 'たぶん' })),
  async (r) => r.map(() => 'はい' as unknown),
  async (r) => r.map(() => [] as unknown),
  async (r) => r.slice(0, 1).map(() => ({ answer: '話の途中' })),
  async () => {
    throw new Error('AI が答えを返さずに終わりました')
  }
]
/** はっきり続く形・言い切りの形(確かめの切れ目は、これで正しく答える) */
const OPEN = /(?:[てでがを]|けど|けれども?|ので|ながら|[、,，])$/u
const CLOSED = /(?:ます|ました|ません|です|でした|[。．!?！？])$/u
/**
 * 区切りごとに決まった(乱数の)答え。2通りの頼み方で同じ答えを返す。はっきりした形の所(確かめの切れ目)は
 * 正しく答える
 */
function randomOracle(seed: number): AskJson {
  return async (requests) =>
    requests.map((r) => {
      const tail = tailBefore(r.prompt)
      if (OPEN.test(tail)) return { answer: '話の途中' }
      if (CLOSED.test(tail)) return { answer: '話の切れ目' }
      const key = tail + r.prompt.split('──── ここ ────')[1]?.slice(0, 40)
      let h = seed
      for (const ch of key) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
      return { reason: '', answer: rng(h)() < 0.5 ? '話の途中' : '話の切れ目' }
    })
}
/** 第4回 N4 の区切り(「あとやはり我々は」の後)と、確かめの例文の「話の途中」だけ「話の途中」と答える */
/** 確かめの例文の「話の途中」「話の切れ目」の、区切りの前の発話 */
const CONTROL_JOIN = new Set(['この坂道を', 'スープが'])
const CONTROL_BREAK = new Set(['以上で今日のロケは終わりです', '今は息子と2人でやっています'])
const n4Oracle = (): ReturnType<typeof oracle> =>
  oracle((t) => t === 'あとやはり我々は' || CONTROL_JOIN.has(t))

const strip = (scenes: readonly Scene[]): unknown =>
  scenes.map((s) => ({ id: s.id, start: s.start, end: s.end, lines: s.lines.map((l) => l.id) }))

describe('AI が使えない・答えが壊れている・食い違うときは公開中の版と同じ区切り', () => {
  it('壊れた答え・投げた頼みでは直さない(0f27f36 と完全一致)', async () => {
    for (const c of CORPORA.slice(0, 20))
      for (const o of OPTIONS) {
        const scenes = buildScenes(c.lines, { start: 0, end: c.end }, o)
        for (const ask of broken) {
          const plan = await planSceneMoves(scenes, o, ask).catch(() => ({ moves: [] }))
          expect(plan.moves, c.name).toEqual([])
          expect(applySceneMoves(scenes, plan.moves, o).scenes).toEqual(
            old.buildScenes(c.lines, { start: 0, end: c.end }, o)
          )
        }
      }
  })

  it('中身によらず先の言葉を選ぶ答えは、2通りの頼み方で食い違うので直さない', async () => {
    for (const c of CORPORA)
      for (const o of OPTIONS) {
        const scenes = buildScenes(c.lines, { start: 0, end: c.end }, o)
        const plan = await planSceneMoves(scenes, o, firstChoice)
        expect(plan.moves, c.name).toEqual([])
      }
  })

  it('直しが無ければ場面はそのまま(id・時刻・発話)', () => {
    for (const c of CORPORA) {
      const scenes = buildScenes(c.lines, { start: 0, end: c.end })
      expect(applySceneMoves(scenes, []).scenes).toEqual(scenes)
    }
  })

  it('答えの読み取り: 知らない言葉・形の崩れた答えは null', () => {
    expect(parseGapAnswer({ answer: '話の途中' })).toBe('continues')
    expect(parseGapAnswer({ answer: '話の切れ目' })).toBe('breaks')
    for (const a of [null, undefined, 1, 'はい', [], {}, { answer: 'はい' }, { cut: 'A' }])
      expect(parseGapAnswer(a)).toBeNull()
  })
})

describe('聞く区切りは怪しいものだけ', () => {
  it('第4回: 言いかけで終わる区切りだけ(言い切りで終わる区切りは、短い場面の端でも聞かない)', () => {
    const scenes = buildScenes(TRIAL4, RANGE)
    const qs = suspectBoundaries(scenes)
    expect(qs.map((q) => q.at.toFixed(2))).toContain('527.18')
    // 言い切り(「…すごく考えました」)で終わる短い場面の端は聞かない
    expect(qs.map((q) => q.at.toFixed(2))).not.toContain('436.91')
    // 第4回 N5(96.34。答えの終わりと次の質問の頭が1つの発話): 発話の境で動かせる先が無い(前の発話の境へ
    // 動かすと後ろの場面が上限 135 秒を超える・後ろへは言いかけの後)ので聞かない(今の区切りのまま)
    expect(qs.map((q) => q.at.toFixed(2))).not.toContain('96.34')
    const n5 = scenes.findIndex((s) => Math.abs(s.end - 96.34) < 0.01)
    expect(boundaryCandidates(scenes[n5], scenes[n5 + 1], {}).map((c) => c.current)).toEqual([true])
    for (const q of qs) {
      const a = scenes[q.index]
      const c = scenes[q.index + 1]
      expect(endsOpen(a.lines[a.lines.length - 1].text)).toBe(true)
      expect(c.lines.length).toBeGreaterThan(0)
    }
  })

  it('言いかけの形: 「…我々は」「…という形で」「…さんは」は言いかけ、「…考えました」「…なのか」は違う', () => {
    expect(endsOpen('あとやはり我々は')).toBe(true)
    expect(endsOpen('一緒に良いところも悪いところも頑張っていこうという形で')).toBe(true)
    expect(endsOpen('実は千崎社長の日立健貴さんは')).toBe(true)
    expect(endsOpen('すごく考えました')).toBe(false)
    expect(endsOpen('どのような政策が必要なのか')).toBe(false)
    expect(endsOpen('114年目になります')).toBe(false)
  })
})

describe('第4回 N4: 文の途中から始まる短い場面', () => {
  it('話の途中と答えれば、9 秒の場面(527.18〜535.87)を前の場面へ入れる。落とさない', async () => {
    const scenes = buildScenes(TRIAL4, RANGE)
    const short = scenes.find((s) => Math.abs(s.start - 527.18) < 0.01)!
    expect(short.end - short.start).toBeLessThan(10)
    const ask = n4Oracle()
    const plan = await planSceneMoves(scenes, {}, ask)
    expect(plan.moves).toEqual([{ at: short.start, to: short.end }])
    // 確かめの切れ目 → 今の区切りの2回だけ。短い場面を入れるときは、動かす先を聞き足さない(新しい切れ目は増えない)
    expect(ask.calls).toHaveLength(2)
    const after = applySceneMoves(scenes, plan.moves).scenes
    expect(after).toHaveLength(scenes.length - 1)
    const merged = after.find((s) => s.lines.some((l) => l.text.startsWith('一緒に良いところ')))!
    expect(merged.lines.map((l) => l.text)).toContain('あとやはり我々は')
    expect(merged.end).toBeCloseTo(535.87, 2)
    expect(merged.end - merged.start).toBeLessThanOrEqual(135)
    // 発話は1つも落ちない・範囲の頭と終わりは同じ
    expect(after.flatMap((s) => s.lines)).toEqual(scenes.flatMap((s) => s.lines))
    expect(after[0].start).toBe(0)
    expect(after[after.length - 1].end).toBe(660)
  })

  it('前のコード(直しの無い区切り)では 9 秒の場面が文の途中から始まる', () => {
    const scenes = old.buildScenes(TRIAL4, RANGE)
    const short = scenes.find((s) => Math.abs(s.start - 527.18) < 0.01)!
    expect(short.lines[0].text).toBe('一緒に良いところも悪いところも頑張っていこうという形で')
  })
})

describe('動かすのは条件を満たす時だけ', () => {
  it('どんな答えでも: 発話の間だけ・前後 3 発話・30 秒以内・長さの上限下限・発話を落とさない', async () => {
    let movedAny = 0
    for (const c of CORPORA)
      for (const o of OPTIONS)
        for (const ask of [randomOracle(1), randomOracle(2), alwaysContinues]) {
          const scenes = buildScenes(c.lines, { start: 0, end: c.end }, o)
          const plan = await planSceneMoves(scenes, o, ask)
          const { scenes: after, applied } = applySceneMoves(scenes, plan.moves, o)
          expect(applied).toEqual(plan.moves)
          movedAny += plan.moves.length
          const maxLen = (o.maxSceneSec ?? 90) * 1.5
          const minTail = o.minTailSec ?? 20
          // 発話は順に全部残る・範囲は同じ・場面はすき間なく並ぶ
          expect(after.flatMap((s) => s.lines)).toEqual(scenes.flatMap((s) => s.lines))
          expect(after[0].start).toBe(scenes[0].start)
          expect(after[after.length - 1].end).toBe(scenes[scenes.length - 1].end)
          after.forEach((s, i) => {
            expect(s.id).toBe(`s${i + 1}`)
            if (i > 0) expect(s.start).toBe(after[i - 1].end)
          })
          for (const m of plan.moves) {
            const i = scenes.findIndex((s) => Math.abs(s.end - m.at) < 1e-9)
            const a = scenes[i]
            const b = scenes[i + 1]
            const lines = [...a.lines, ...b.lines]
            const merge = m.to === a.start || m.to === b.end
            if (merge) {
              // 丸ごと入れるのは短い場面だけ
              const gone = m.to === b.end ? b : a
              expect(gone.end - gone.start).toBeLessThan(minTail)
              expect(gone.lines.length).toBeLessThanOrEqual(MAX_SHIFT_LINES)
            } else {
              expect(Math.abs(m.to - m.at)).toBeLessThanOrEqual(MAX_SHIFT_SEC)
              const k = lines.filter((l) => l.start < m.to).length
              expect(Math.abs(k - a.lines.length)).toBeLessThanOrEqual(MAX_SHIFT_LINES)
              // 発話の間(間が `MIN_GAP_SEC` 以上)にある
              const prevEnd = Math.max(...lines.slice(0, k).map((l) => l.end))
              expect(lines[k].start - prevEnd).toBeGreaterThanOrEqual(MIN_GAP_SEC)
              expect(m.to).toBeGreaterThan(prevEnd)
              expect(m.to).toBeLessThan(lines[k].start)
              // 新しい区切りの前は言いかけで終わらない
              expect(endsOpen(lines[k - 1].text)).toBe(false)
            }
            // 動いた2つの場面の長さ: 上限を超えて伸びない・下限を割って縮まない
            const now = after.filter((s) => s.end > a.start + 1e-9 && s.start < b.end - 1e-9)
            // 丸ごと入れたら残った方の場面、動かしたら前・後ろの場面と比べる
            const was0 = merge ? (m.to === b.end ? a : b) : a
            now.forEach((s, j) => {
              const before = j === 0 ? was0 : b
              const len = s.end - s.start
              const was = before.end - before.start
              expect(len <= maxLen + 1e-6 || len <= was + 1e-6).toBe(true)
              expect(len >= minTail - 1e-6 || len >= was - 1e-6).toBe(true)
            })
            expect(now).toHaveLength(merge ? 1 : 2)
          }
          // 1つの場面に2つの直しは掛けない
          const touched = plan.moves.flatMap((m) => {
            const i = scenes.findIndex((s) => Math.abs(s.end - m.at) < 1e-9)
            return [i, i + 1]
          })
          expect(new Set(touched).size).toBe(touched.length)
        }
    expect(movedAny).toBeGreaterThan(50)
  })

  it('何でも「話の途中」・何でも「話の切れ目」と答える AI は、確かめの切れ目を外すので使わない', async () => {
    const scenes = buildScenes(TRIAL4, RANGE)
    for (const ask of [oracle(() => true), oracle(() => false)]) {
      const plan = await planSceneMoves(scenes, {}, ask)
      expect(plan.moves).toEqual([])
      expect(plan.untrusted).toBe('missed-control')
      // 確かめの切れ目だけを聞いて止める(怪しい区切りの分は頼まない)
      expect(ask.calls).toHaveLength(1)
      expect(plan.requests).toBe(ask.calls[0].length)
    }
  })

  it('確かめの切れ目は作った例文(切れ目・途中の両方。収録の文字起こしによらず聞ける)', () => {
    const scenes = buildScenes(TRIAL4, RANGE)
    const c = controlGaps(scenes)
    expect(c.map((x) => x.expect).sort()).toEqual(['breaks', 'breaks', 'continues', 'continues'])
    expect(c.every((x) => x.all.every((l) => l.speaker === 'マイク1'))).toBe(true)
    expect(controlGaps(buildScenes([], RANGE))).toHaveLength(4)
  })

  it('話の途中でも、動かす先がどれも話の途中なら動かさない(短い場面の端でないとき)', async () => {
    const scenes = buildScenes(TRIAL4, RANGE)
    // 確かめの切れ目は正しく答え、ほかは全部「話の途中」
    const plan = await planSceneMoves(
      scenes,
      {},
      oracle((t) => !CONTROL_BREAK.has(t))
    )
    expect(plan.untrusted).toBeUndefined()
    expect(plan.moves.length).toBeGreaterThan(0)
    for (const m of plan.moves) {
      const i = scenes.findIndex((s) => Math.abs(s.end - m.at) < 1e-9)
      expect([scenes[i].start, scenes[i + 1].end]).toContain(m.to)
    }
  })

  it('第4回: 動かす先が一区切りと答えた所へ、今の区切りに近い方から動かす', async () => {
    const scenes = buildScenes(TRIAL4, RANGE)
    // 326.07 の区切り(「直営の店の方は」の後)は話の途中、その前の「114年目になります」の後は切れ目
    const ask = oracle((t) => t === '直営の店の方は' || CONTROL_JOIN.has(t))
    const plan = await planSceneMoves(scenes, {}, ask)
    expect(ask.calls).toHaveLength(3)
    expect(plan.moves).toHaveLength(1)
    expect(plan.moves[0].at).toBeCloseTo(326.07, 2)
    const after = applySceneMoves(scenes, plan.moves).scenes
    const next = after.find((s) => s.lines.some((l) => l.text === '直営の店の方は'))!
    expect(next.lines[0].text).toBe('直営の店の方は')
    expect(after.find((s) => s.end === next.start)!.lines.at(-1)!.text).toBe('114年目になります')
  })

  it('候補: 間が `MIN_GAP_SEC` 未満の発話の間には動かさない', () => {
    const l = (id: string, start: number, end: number, text: string): TimedLine => ({
      id,
      start,
      end,
      text,
      overlap: false
    })
    const a: Scene = {
      id: 's1',
      start: 0,
      end: 40.5,
      speech: 0,
      lines: [l('a', 0, 30, 'いろいろ話して'), l('b', 30.05, 40, 'それで我々は')]
    }
    const c: Scene = {
      id: 's2',
      start: 40.5,
      end: 80,
      speech: 0,
      lines: [l('c', 41, 50, '続けました'), l('d', 50.1, 79, 'ありがとうございました')]
    }
    const times = boundaryCandidates(a, c, {}).map((x) => x.time)
    expect(times).toEqual([40.5])
  })
})

describe('保存した直しで開き直す', () => {
  it('同じ直しを当てると、作った時と同じ区切り(id・時刻・発話)', async () => {
    for (const c of CORPORA)
      for (const o of OPTIONS) {
        const scenes = buildScenes(c.lines, { start: 0, end: c.end }, o)
        const plan = await planSceneMoves(scenes, o, randomOracle(7))
        const made = applySceneMoves(scenes, plan.moves, o).scenes
        // 保存は時刻の組だけ(JSON を通す)
        const saved = JSON.parse(JSON.stringify(plan.moves)) as SceneMove[]
        const reopened = applySceneMoves(
          buildScenes(c.lines, { start: 0, end: c.end }, o),
          saved,
          o
        )
        expect(strip(reopened.scenes), c.name).toEqual(strip(made))
        expect(reopened.applied).toEqual(saved)
      }
  })

  it('当たらなくなった直し(文字起こしを直して区切りが変わった)は当てない', () => {
    const scenes = buildScenes(TRIAL4, RANGE)
    const r = applySceneMoves(scenes, [
      { at: 12.34, to: 20 },
      { at: 527.18, to: 600 }
    ])
    expect(r.applied).toEqual([])
    expect(r.scenes).toEqual(scenes)
  })
})

describe('人の残す/落とすは覆らない', () => {
  it('第4回 N4: 直した場面と直す前の場面の対応で、前の場面の印をそのまま引き継ぐ', async () => {
    const base = buildScenes(TRIAL4, RANGE)
    const plan = await planSceneMoves(base, {}, n4Oracle())
    const moved = applySceneMoves(base, plan.moves).scenes
    // 直しが当たらなくなって元の区切りに戻ったとき(保存: 直した場面 → 今: 元の場面)
    for (const flag of [true, false]) {
      const flags = Object.fromEntries(moved.map((s) => [s.id, flag]))
      const back = remapSceneFlags(flags, matchScenesAcrossMoves(moved, base, plan.moves))
      expect(Object.keys(back).sort()).toEqual(base.map((s) => s.id).sort())
      expect(Object.values(back).every((v) => v === flag)).toBe(true)
    }
    // 直す前の企画(保存: 元の場面)と直した場面: 公開中の版の対応で、入れた先の場面は前の場面の印
    const match = matchScenesByTime(base, moved)
    const merged = moved.find((s) => Math.abs(s.end - 535.87) < 0.01)!
    const prev = base.find((s) => Math.abs(s.end - 527.18) < 0.01)!
    expect(match.get(merged.id)).toBe(prev.id)
  })

  it('どんな直しでも、直した場面の印は大半を占める元の場面の印(残す/落とすを入れ替えない)', async () => {
    for (const c of CORPORA) {
      const base = buildScenes(c.lines, { start: 0, end: c.end })
      const plan = await planSceneMoves(base, {}, randomOracle(3))
      const moved = applySceneMoves(base, plan.moves).scenes
      const r = rng(c.lines.length)
      const flags = Object.fromEntries(moved.map((s) => [s.id, r() < 0.5]))
      const back = remapSceneFlags(flags, matchScenesAcrossMoves(moved, base, plan.moves))
      for (const b of base) {
        const owner = moved
          .map((m) => ({ m, ov: Math.min(m.end, b.end) - Math.max(m.start, b.start) }))
          .sort((x, y) => y.ov - x.ov)[0].m
        expect(back[b.id], c.name).toBe(flags[owner.id])
      }
    }
  })
})

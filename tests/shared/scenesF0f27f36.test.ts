import { describe, expect, it } from 'vitest'
import * as now from '../../src/shared/structure/scenes'
import * as old from './fixtures/scenesF0f27f36'
import { matchScenesByTime, remapSceneFlags } from '../../src/renderer/src/lib/pipelineRestore'
import { KIND_PROFILES } from '../../src/shared/structure/kind'
import { TRIAL3_TRANSCRIPT } from './fixtures/trial3Transcript'
import { TRIAL4_TRANSCRIPT } from './fixtures/trial4Transcript'

/**
 * 場面の区切り・場面の選び方・開き直したときの場面の対応は、公開中の版(0f27f36)と完全に同じ。
 * 第4回の直し(N4・N5)と、その監査の直しで区切り・選び方を手で調整したが、0f27f36 より悪くなる所が出た
 * (場面が粗くなり仕上がりが目標から外れる・開き直しで人が落とした場面が残る側に変わる 等)ので戻した。
 * 足したのは、長さで落とした場面の決め手の記録(`by` の refit)だけで、残す・落とす場面は変えない
 */
type Line = now.TimedLine

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
/** 質問・依頼・挨拶・「は」終わり・続きのある形・言い切り・発話の中の質問の頭 */
const TEXTS = [
  'それで現場ではいろいろな工夫をしてきまして',
  'やはり思い切って価格を上げたというのは',
  'そのあたりについてどういった背景から可能となったのか',
  'ぜひお聞かせいただきたいなと思います',
  '人手の確保について現場ではどういったことをされているのでしょうか',
  '私どもでは採用の方法を変えました',
  'あとやはり我々は',
  '一緒に頑張っていこうという形で',
  'こんにちは',
  '今日は',
  'お名前は',
  'ご出身は',
  'では次に田中さん、いかがですか',
  '考えております実は千崎社長の日立健貴さんは',
  '具体的にどういったですね取り組みをされてその下請けさんから高い評価',
  '得られているのかという話を',
  'えっ、何それ?',
  'すごい!',
  'ありがとうございました'
]
function synthetic(seed: number): { lines: Line[]; end: number } {
  const r = rng(seed)
  const lines: Line[] = []
  let t = r() * 5
  const length = 300 + r() * 1500
  while (t < length) {
    const d = 0.5 + r() * 8
    lines.push({
      id: `l${lines.length}`,
      speaker: r() < 0.5 ? 'A' : 'B',
      start: t,
      end: t + d,
      text: TEXTS[Math.floor(r() * TEXTS.length)],
      overlap: r() < 0.05
    })
    const x = r()
    // 短い間・1〜4 秒・4〜8 秒(つなぐかどうかの境)・長い無言
    t +=
      d +
      (x < 0.6 ? 0.05 + r() * 0.9 : x < 0.8 ? 1 + r() * 3 : x < 0.95 ? 4 + r() * 4 : 8 + r() * 20)
  }
  return { lines, end: t + r() * 15 }
}
const fromFixture = (rows: readonly (readonly [number, number, string])[]): Line[] =>
  rows.map(([start, end, text], i) => ({
    id: `u${i}`,
    speaker: 'マイク1',
    start,
    end,
    text,
    overlap: false
  }))

const CORPORA: { name: string; lines: Line[]; end: number }[] = [
  { name: '第3回', lines: fromFixture(TRIAL3_TRANSCRIPT), end: 660 },
  { name: '第4回', lines: fromFixture(TRIAL4_TRANSCRIPT), end: 660 },
  ...Array.from({ length: 120 }, (_, i) => ({ name: `合成 ${i + 1}`, ...synthetic(i + 1) }))
]
const OPTIONS = [KIND_PROFILES.location.scene, KIND_PROFILES.game.scene]

/** 判定(点数・印)を決まった種から。同点・「不要」・見どころを混ぜる */
function judgementsFor(scenes: readonly now.Scene[], seed: number): now.SceneJudgement[] {
  const r = rng(seed * 7919)
  return scenes.map((s) => {
    const x = r()
    return {
      sceneId: s.id,
      score: x < 0.3 ? 60 : Math.round(r() * 100),
      kind: x < 0.1 ? 'unneeded' : x < 0.35 ? 'highlight' : 'normal',
      reason: ''
    }
  })
}
/** 決め手の記録(refit)は今の版で足したもの。0f27f36 では score */
const normalize = (sel: now.Selection): now.Selection => ({
  ...sel,
  dropped: sel.dropped.map((d) => (d.by === 'refit' ? { ...d, by: 'score' } : d))
})

describe('公開中の版(0f27f36)と完全に同じ', () => {
  it('場面の区切り(id・start・end・発話)', () => {
    for (const c of CORPORA)
      for (const o of OPTIONS)
        expect(now.buildScenes(c.lines, { start: 0, end: c.end }, o), c.name).toEqual(
          old.buildScenes(c.lines, { start: 0, end: c.end }, o)
        )
  })

  it('選ぶ場面・落とす場面(目標 3 通り・目標なし・点数の下限・不要を落とさない)', () => {
    let seed = 0
    for (const c of CORPORA) {
      const scenes = now.buildScenes(c.lines, { start: 0, end: c.end })
      const total = scenes.reduce((t, s) => t + s.end - s.start, 0)
      for (const judgements of [
        judgementsFor(scenes, ++seed),
        now.heuristicJudgements(scenes, 'location')
      ]) {
        const cases: [number, number, boolean][] = [
          [total * 0.25, -Infinity, true],
          [total * 0.5, -Infinity, true],
          [total * 0.8, -Infinity, true],
          [Infinity, -Infinity, true],
          [Infinity, 50, true],
          [total * 0.5, -Infinity, false]
        ]
        for (const [target, minScore, dropUnneeded] of cases) {
          const a = now.selectScenes(scenes, judgements, target, undefined, minScore, dropUnneeded)
          const b = old.selectScenes(scenes, judgements, target, undefined, minScore, dropUnneeded)
          expect(normalize(a), `${c.name} ${target} ${minScore}`).toEqual(b)
        }
      }
    }
  })

  it('開き直したときの場面の対応と、残す/落とすの印の移し方', () => {
    for (const c of CORPORA) {
      const prev = now.buildScenes(c.lines, { start: 0, end: c.end }, KIND_PROFILES.game.scene)
      const next = now.buildScenes(c.lines, { start: 0, end: c.end })
      for (const [p, n] of [
        [prev, next],
        [next, prev]
      ]) {
        const a = matchScenesByTime(p, n)
        const b = old.matchScenesByTime(p, n)
        expect([...a], c.name).toEqual([...b])
        const flags = Object.fromEntries(p.map((s, i) => [s.id, i % 3 === 0]))
        expect(remapSceneFlags(flags, a)).toEqual(old.remapSceneFlags(flags, b))
      }
    }
  })
})

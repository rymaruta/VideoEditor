import { describe, expect, it } from 'vitest'
import {
  buildScenes,
  continuesSentence,
  indistinctJudgements,
  sceneSubstance,
  selectScenes,
  type Scene,
  type SceneJudgement,
  type TimedLine
} from '../../src/shared/structure/scenes'

/** 試し編集 第2回(首相官邸の車座対話・11 分・マイク1本)で見つかった構成の不具合 */

let n = 0
const line = (start: number, end: number, text: string, speaker = 'マイク1'): TimedLine => ({
  id: `l${++n}`,
  speaker,
  start,
  end,
  text,
  overlap: false
})

describe('AI が全部の場面に同じ点を付けたとき(不具合 2)', () => {
  // 9 場面(各 60 秒)。s2 は具体的な数字・固有名詞の多い場面、ほかは中身の薄い場面
  const thin = (i: number): Scene => {
    const t = i * 60
    const lines = [line(t + 2, t + 20, 'そうですねまあいろいろとありますけれども')]
    return { id: `s${i + 1}`, start: t, end: t + 60, lines, speech: 18 }
  }
  const rich: Scene = {
    id: 's2',
    start: 60,
    end: 120,
    lines: [
      line(61, 80, '今年2024年は社員1人当たり平均5%の賃上げを行いました'),
      line(81, 100, '千崎社長の日立建機さんは取引先様と30社ほど交渉されたと'),
      line(101, 118, 'コストは約10%上がりましたがパートさんも3%上げました')
    ],
    speech: 55
  }
  const scenes = Array.from({ length: 9 }, (_, i) => (i === 1 ? rich : thin(i)))
  const same: SceneJudgement[] = scenes.map((s) => ({
    sceneId: s.id,
    score: 85,
    kind: 'highlight',
    reason: '文字起こしの言い換え',
    mood: '楽しい'
  }))

  it('区別できていないことを見分ける(全部が同じ点・同じ印)', () => {
    expect(sceneSubstance(rich)).toBeGreaterThan(sceneSubstance(thin(2)))
    expect(indistinctJudgements(same)).toEqual({ total: 9, score: 85, kind: 'highlight' })
    const varied = same.map((j, i) => (i === 3 ? { ...j, score: 60 } : j))
    expect(indistinctJudgements(varied)).toBeNull()
  })

  it('長さに合わせて落とす場面は、並び順ではなく中身の手掛かり(数字・固有名詞・発話)で選ぶ', () => {
    // 7 場面分の長さ: 2 場面を落とす
    const r = selectScenes(scenes, same, 7 * 60)
    const dropped = r.dropped.map((d) => d.sceneId)
    expect(dropped).toHaveLength(2)
    expect(r.dropped.every((d) => d.why === 'length')).toBe(true)
    // いちばん具体的な s2 は残す(前は並び順で s2 から落ちていた)
    expect(r.kept).toContain('s2')
    // 番組の頭と終わりも残す
    expect(r.kept).toContain('s1')
    expect(r.kept).toContain('s9')
  })
})

describe('判定が区別できている回は「前後が落ちた場面から落とす」が先(監査 D1)', () => {
  it('同点の場面どうしでは、中身の手掛かりより前後が落ちているかを先に見る', () => {
    const sc = (i: number, rich: boolean): Scene => {
      const t = i * 60
      const lines = rich
        ? [line(t + 1, t + 50, '日立建機の千崎社長と30社・5%・2024年の交渉')]
        : [line(t + 1, t + 20, 'そうですね')]
      return { id: `s${i + 1}`, start: t, end: t + 60, lines, speech: rich ? 49 : 19 }
    }
    // s2 が最も低い(先に落ちる)。次に同点 40 の s3(s2 の隣・中身が濃い)と s5(離れている・中身が薄い)
    const scenes = [
      sc(0, false),
      sc(1, false),
      sc(2, true),
      sc(3, false),
      sc(4, false),
      sc(5, false)
    ]
    const scores = [90, 30, 40, 70, 40, 90]
    const j: SceneJudgement[] = scenes.map((s, i) => ({
      sceneId: s.id,
      score: scores[i],
      kind: 'normal',
      reason: ''
    }))
    const r = selectScenes(scenes, j, 4 * 60)
    expect(r.dropped.map((d) => d.sceneId)).toEqual(['s2', 's3'])
  })
})

describe('場面の区切りを文の途中に入れない(不具合 3)', () => {
  it('続きのある形で終わる発話(「…というのは」)の後ろでは、長さで分けない', () => {
    expect(continuesSentence('思い切って10%価格を上げたというのは')).toBe(true)
    expect(continuesSentence('ものすごい挑戦だったというふうに思うんです')).toBe(false)
    expect(continuesSentence('こんにちは')).toBe(false)
    expect(continuesSentence('取引先様と交渉しましたが、')).toBe(true)
  })

  it('90 秒を越えた所の切れ目が質問の途中なら、次の文の切れ目で分ける', () => {
    // 0〜88 秒: 話が続く。88〜92.9 秒「…というのは」/ 94.5〜97 秒「ものすごい挑戦だった…思うんです」
    const lines: TimedLine[] = []
    for (let t = 0; t < 88; t += 8) lines.push(line(t, t + 6.5, 'それでですね色々と考えております'))
    lines.push(line(88, 92.9, '思い切って10%価格を上げたというのは'))
    lines.push(line(94.5, 97, 'ものすごい挑戦だったというふうに思うんです'))
    lines.push(line(98.5, 104, 'そのあたりの決断についてお聞かせいただきたい'))
    lines.push(line(106, 140, 'そうですね当時はとにかく悩みました'))
    const scenes = buildScenes(lines, { start: 0, end: 150 }, { minTailSec: 0 })
    expect(scenes.length).toBeGreaterThan(1)
    // 「…というのは」と「ものすごい挑戦だった」は同じ場面
    const q = scenes.find((s) => s.lines.some((l) => l.text.endsWith('というのは')))!
    expect(q.lines.some((l) => l.text.startsWith('ものすごい挑戦'))).toBe(true)
    // どの場面も、続きのある形で終わる発話の直後から始まらない
    for (let i = 1; i < scenes.length; i++) {
      const prev = scenes[i - 1].lines.at(-1)
      if (prev) expect(continuesSentence(prev.text)).toBe(false)
    }
  })
})

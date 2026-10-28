import { describe, expect, it } from 'vitest'
import {
  buildScenes,
  endsQuestion,
  indistinctJudgements,
  questionHolds,
  sceneSubstance,
  selectScenes,
  type Scene,
  type SceneJudgement,
  type TimedLine
} from '../../src/shared/structure/scenes'
import { TRIAL3_TRANSCRIPT } from './fixtures/trial3Transcript'

/** 試し編集 第3回(首相官邸の車座対話・11 分・マイク1本)で残った構成の不具合 */

const trial3Lines = (): TimedLine[] =>
  TRIAL3_TRANSCRIPT.map(([start, end, text], i) => ({
    id: `u${i}`,
    speaker: 'マイク1',
    start,
    end,
    text,
    overlap: false
  }))

describe('場面の区切りを質問の途中に入れない(#3)', () => {
  it('疑問・依頼で終わる発話を見分ける', () => {
    expect(endsQuestion('ぜひお聞かせいただきたいなと思います')).toBe(true)
    expect(endsQuestion('どういった背景から可能となったのか')).toBe(true)
    expect(endsQuestion('そのあたり会長の思い切った決断について')).toBe(true)
    expect(endsQuestion('どのようにお考えでしょうか。')).toBe(true)
    expect(endsQuestion('ぜひ教えてください')).toBe(true)
    expect(endsQuestion('ものすごい挑戦だったというふうに思うんです')).toBe(false)
    expect(endsQuestion('頑張ってまいりました')).toBe(false)
  })

  it('短い問い返し・驚き(「えっ、何それ?」)は質問とみなさない', () => {
    const lines: TimedLine[] = [
      { id: 'a', start: 0, end: 2, text: 'すごい!これは本当に面白いですね!', overlap: false },
      { id: 'b', start: 2.3, end: 4, text: 'えっ、ちょっと待って、何それ?', overlap: false },
      { id: 'c', start: 4.3, end: 6, text: 'じゃあ次の場所へ移動しましょうか', overlap: false }
    ]
    expect(questionHolds(lines, 8)).toEqual([])
  })

  it('第3回の実文: 補佐官の質問(219.9 秒〜)とその答えを同じ場面に入れる', () => {
    const scenes = buildScenes(trial3Lines(), { start: 0, end: 660 })
    const sceneOf = (text: string): string =>
      scenes.find((s) => s.lines.some((l) => l.text === text))!.id
    // 前は 227.05 秒で区切り、仕上がりが「そのあたり会長の思い切った決断について」から始まった
    const q = sceneOf('そのあたり会長の思い切った決断について')
    expect(sceneOf('やはり思い切って10%の価格を上げたというのは')).toBe(q)
    expect(sceneOf('ものすごい挑戦だったというふうに思うんです')).toBe(q)
    expect(sceneOf('ぜひお聞かせいただきたいなと思います')).toBe(q)
    // 答えの頭も同じ場面
    expect(sceneOf('直営の店の方では接客力の向上を図ったりまた商品の方では')).toBe(q)
    // 区切りは質問の頭(219.73 秒の発話の後)より前
    const scene = scenes.find((s) => s.id === q)!
    expect(scene.start).toBeLessThanOrEqual(219.88)
    for (const s of scenes) expect(s.start <= 219.88 || s.start >= 241).toBe(true)
  })

  it('質問の前置き(「では次に」「○○さん、」)で区切る', () => {
    // 85 秒話し続けた後に質問が来る。長さの目安(90 秒)は質問の途中で超える
    const lines: TimedLine[] = []
    for (let t = 0; t < 84; t += 4)
      lines.push({
        id: `a${t}`,
        start: t,
        end: t + 3.8,
        text: '工場では毎日いろいろな改善をして',
        overlap: false
      })
    lines.push({ id: 'a84', start: 84, end: 85.5, text: 'まいりました', overlap: false })
    lines.push({ id: 'q1', start: 86, end: 88, text: 'では次に山田さん、', overlap: false })
    lines.push({
      id: 'q2',
      start: 88.3,
      end: 92,
      text: '人手の確保について現場ではどういったことを',
      overlap: false
    })
    lines.push({
      id: 'q3',
      start: 92.3,
      end: 95,
      text: 'されているのか教えてください',
      overlap: false
    })
    lines.push({
      id: 'r1',
      start: 96,
      end: 100,
      text: 'はい私どもでは採用の方法を変えまして',
      overlap: false
    })
    lines.push({
      id: 'r2',
      start: 100.3,
      end: 104,
      text: '地元の高校との結び付きを強めてきました',
      overlap: false
    })
    const scenes = buildScenes(lines, { start: 0, end: 110 })
    const of = (id: string): string => scenes.find((s) => s.lines.some((l) => l.id === id))!.id
    expect(of('q1')).toBe(of('q3'))
    expect(of('q1')).toBe(of('r1'))
    expect(of('q1')).not.toBe(of('a0'))
    expect(scenes.find((s) => s.id === of('q1'))!.lines[0].id).toBe('q1')
  })
})

describe('ほぼ同点・全部同点のときの場面の選び方(N2・N3)', () => {
  const judge = (ids: string[], score = 85): SceneJudgement[] =>
    ids.map((sceneId) => ({ sceneId, score, kind: 'highlight', reason: '' }))

  it('9 場面中 8 場面が同じ点(第3回の本番: s2 だけ 80 点)も「区別できていない」とみなす', () => {
    const j = judge(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']).map((x) =>
      x.sceneId === 's2' ? { ...x, score: 80 } : x
    )
    expect(indistinctJudgements(j)).toEqual({ total: 8, score: 85, kind: 'highlight', of: 9 })
    // 全部同じ点は今までどおり
    expect(indistinctJudgements(judge(['a', 'b', 'c']))).toEqual({
      total: 3,
      score: 85,
      kind: 'highlight'
    })
  })

  // 全部同点(第3回で s2 を 85 点にして作り直した): 8 秒・9 秒の短い場面まで落とし、目標 8 分に 7:12 だった
  let n = 0
  const sceneOf = (id: string, start: number, dur: number, texts: string[], fill = 0.9): Scene => {
    const step = dur / Math.max(1, texts.length)
    const lines = texts.map((text, i) => ({
      id: `${id}-${++n}`,
      speaker: 'マイク1',
      start: start + i * step,
      end: start + i * step + step * fill,
      text,
      overlap: false
    }))
    return { id, start, end: start + dur, lines, speech: dur * fill }
  }
  const rich = (id: string, start: number, dur: number): Scene =>
    sceneOf(id, start, dur, [
      '今年2024年は社員1人当たり5%の賃上げを行いました',
      '千崎社長の日立建機さんとは取引先様30社と交渉しました',
      'コストは約10%上がりましたがパートさんも3%上げました'
    ])
  const scenes: Scene[] = [
    rich('s1', 0, 60),
    rich('s2', 60, 60),
    rich('s3', 120, 60),
    rich('s4', 180, 60),
    sceneOf('s5', 240, 100, ['そうですねやっぱり皆さんと一緒に頑張っていこうという形で'], 0.85),
    sceneOf('s6', 340, 8, ['はい'], 0.3),
    sceneOf('s7', 348, 60, ['そうですね2年前にですねいろいろと考えまして'], 0.8),
    sceneOf('s8', 408, 9, ['ええ'], 0.3),
    rich('s9', 417, 60)
  ]
  const same = judge(scenes.map((s) => s.id))

  it('目標に近づける: 1つ落とせば収まるなら目標を大きく下回る場面は選ばず、短い場面を落としすぎない', () => {
    // 前提: 短い s6・s8 が中身の手掛かりのいちばん少ない場面、次が長い s5
    const sub = Object.fromEntries(scenes.map((s) => [s.id, sceneSubstance(s)]))
    expect(sub.s6).toBeLessThan(sub.s5)
    expect(sub.s8).toBeLessThan(sub.s5)
    const total = scenes.reduce((t, s) => t + s.end - s.start, 0)
    const target = total - 37
    const r = selectScenes(scenes, same, target)
    expect(r.estimated).toBeLessThanOrEqual(target)
    // 前は s6(8 秒)・s8(9 秒)・s5(100 秒)を落とし、目標を 80 秒下回った
    expect(r.kept).toContain('s6')
    expect(r.kept).toContain('s8')
    expect(target - r.estimated).toBeLessThan(30)
  })

  it('落としすぎた短い場面は、戻しても目標に収まるなら戻す', () => {
    const total = scenes.reduce((t, s) => t + s.end - s.start, 0)
    const target = total - 120
    const r = selectScenes(scenes, same, target)
    expect(r.estimated).toBeLessThanOrEqual(target)
    const back = r.kept.filter((id) => id === 's6' || id === 's8')
    expect(back.length).toBeGreaterThan(0)
    // 落とした場面のうち、戻しても収まるものは残っていない
    for (const d of r.dropped) {
      const s = scenes.find((x) => x.id === d.sceneId)!
      expect(r.estimated + (s.end - s.start)).toBeGreaterThan(target)
    }
  })
})

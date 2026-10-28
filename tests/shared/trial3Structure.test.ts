import { describe, expect, it } from 'vitest'
import { buildScenes, endsQuestion, type TimedLine } from '../../src/shared/structure/scenes'
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

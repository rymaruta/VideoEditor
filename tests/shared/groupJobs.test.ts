import { describe, expect, it } from 'vitest'
import { groupAsrJobs, splitGroupWords } from '../../src/shared/diarize/groupJobs'
import type { AsrJob, AsrWord } from '../../src/shared/transcript'

const job = (id: string, path: string, start: number, end: number): AsrJob => ({
  id,
  path,
  start,
  end
})

describe('groupAsrJobs', () => {
  it('同じマイクで続く発話を 28 秒までまとめる。間が空きすぎたら・別のマイクならまとめない', () => {
    const g = groupAsrJobs([
      job('a1', '/A.wav', 0, 4),
      job('b1', '/B.wav', 4, 8),
      job('a2', '/A.wav', 9, 12),
      job('a3', '/A.wav', 13, 27),
      // 窓に入りきらない
      job('a4', '/A.wav', 28, 31),
      // 間が 6 秒より空く
      job('a5', '/A.wav', 40, 42)
    ])
    expect(g.map((x) => [x.path, x.start, x.end, x.parts.map((p) => p.id)])).toEqual([
      ['/A.wav', 0, 27, ['a1', 'a2', 'a3']],
      ['/A.wav', 28, 31, ['a4']],
      ['/A.wav', 40, 42, ['a5']],
      ['/B.wav', 4, 8, ['b1']]
    ])
  })
})

describe('splitGroupWords', () => {
  it('単語を時刻で元の発話へ振り分け、発話の外の単語(回り込み)は捨てる', () => {
    const [group] = groupAsrJobs([job('a1', '/A.wav', 0, 4), job('a2', '/A.wav', 9, 12)])
    const w = (text: string, start: number, end: number): AsrWord => ({ text, start, end })
    const r = splitGroupWords(group, [
      w('水を', 0.5, 1),
      w('買う', 1, 1.5),
      // 4〜9 秒はほかの人の番(回り込んだ声)
      w('それは', 6, 6.5),
      w('許可書', 9.2, 9.8),
      w('OK', 10, 10.3),
      w('Google', 10.4, 10.8)
    ])
    expect(r).toEqual([
      { id: 'a1', text: '水を買う', words: [w('水を', 0.5, 1), w('買う', 1, 1.5)] },
      {
        id: 'a2',
        text: '許可書OK Google',
        words: [w('許可書', 9.2, 9.8), w('OK', 10, 10.3), w('Google', 10.4, 10.8)]
      }
    ])
  })
})

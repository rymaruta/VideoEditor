import { describe, expect, it, vi } from 'vitest'

// AI の答えを差し替える(場面ごとの kind を決めて返す)
const answer = vi.hoisted(() => ({ kinds: [] as string[] }))
vi.mock('@renderer/lib/ai', () => ({
  askAiJson: async (_p: unknown, _k: unknown, reqs: { prompt: string }[]) => ({
    results: reqs.map((r) => {
      const ids = [...r.prompt.matchAll(/\b(s\d+)\b/g)].map((m) => m[1])
      return Object.fromEntries(
        [...new Set(ids)].map((id) => [
          id,
          {
            kind: answer.kinds[Number(id.slice(1))] ?? 'normal',
            score: 80,
            reason: 'r',
            title: 't'
          }
        ])
      )
    }),
    model: 'm'
  })
}))
import { judgeScenes } from '@renderer/lib/roughCutPlan'
import type { Scene } from '@shared/structure/scenes'

const scenes: Scene[] = Array.from({ length: 10 }, (_, i) => ({
  id: `s${i}`,
  start: i * 60,
  end: i * 60 + 60,
  lines: [
    { id: `l${i}`, start: i * 60 + 1, end: i * 60 + 5, text: 'あ', speaker: 'A', overlap: false }
  ],
  speech: 4,
  hype: i === 3 ? 2 : 0
}))
const opts = {
  provider: 'local' as const,
  apiKey: '',
  episodeName: 'e',
  targetSec: 0,
  kind: 'game' as const
}

describe('AI の「見どころ」が見分けになっていないとき', () => {
  it('「面白い所だけ」で半分を超える場面を見どころにしたら、見どころの印と点数だけを点数の判定に置き換える', async () => {
    answer.kinds = Array.from({ length: 10 }, (_, i) =>
      i === 9 ? 'unneeded' : i < 8 ? 'highlight' : 'normal'
    )
    const r = await judgeScenes(scenes, 600, opts)
    expect(r.source).toBe('ai')
    expect(r.rejected).toContain('10 場面中 8 場面')
    // 山のある場面が一番高い。題(AI のもの)と「不要」の印は残す
    const best = r.judgements
      .filter((j) => j.kind !== 'unneeded')
      .sort((a, b) => b.score - a.score)[0]
    expect(best.sceneId).toBe('s3')
    expect(best.title).toBe('t')
    expect(r.judgements.find((j) => j.sceneId === 's9')?.kind).toBe('unneeded')
    expect(r.judgements.filter((j) => j.kind === 'highlight').length).toBeLessThan(8)
  })

  it('見どころの数が残し方を決めない方針・長さの目標があるときは、AI の答えをそのまま使う', async () => {
    answer.kinds = Array.from({ length: 10 }, () => 'highlight')
    for (const o of [
      { ...opts, kind: 'location' as const },
      { ...opts, policy: 'tempo' as const },
      { ...opts, targetSec: 300 }
    ]) {
      const r = await judgeScenes(scenes, 600, o)
      expect(r.rejected).toBeUndefined()
      expect(r.judgements.every((j) => j.kind === 'highlight')).toBe(true)
    }
  })

  it('見どころが少数なら AI の答えを使う', async () => {
    answer.kinds = Array.from({ length: 10 }, (_, i) => (i < 3 ? 'highlight' : 'normal'))
    const r = await judgeScenes(scenes, 600, opts)
    expect(r.source).toBe('ai')
    expect(r.rejected).toBeUndefined()
  })
})

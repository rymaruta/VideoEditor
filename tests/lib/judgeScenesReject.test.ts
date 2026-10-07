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
  it('半分を超える場面を見どころにした答えは使わず、声の盛り上がりなどの点数で判定する', async () => {
    answer.kinds = Array.from({ length: 10 }, (_, i) => (i < 9 ? 'highlight' : 'normal'))
    const r = await judgeScenes(scenes, 600, opts)
    expect(r.source).toBe('heuristic')
    expect(r.rejected).toContain('10 場面中 9 場面')
    // 山のある場面が一番高い
    const best = [...r.judgements].sort((a, b) => b.score - a.score)[0]
    expect(best.sceneId).toBe('s3')
  })
  it('見どころが少数なら AI の答えを使う', async () => {
    answer.kinds = Array.from({ length: 10 }, (_, i) => (i < 3 ? 'highlight' : 'normal'))
    const r = await judgeScenes(scenes, 600, opts)
    expect(r.source).toBe('ai')
    expect(r.rejected).toBeUndefined()
  })
})

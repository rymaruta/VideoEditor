import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Scene } from '@shared/structure/scenes'
import {
  chooseLocalModel,
  CPU_LOCAL_MODEL,
  CPU_SAFE_MODEL_GB,
  judgeLocalModelLoad
} from '@shared/llm'

/**
 * GPU の無い PC では CPU 用の 1.5B を使う(10/09 版は GPU が無くても AI を試していた。7B しか
 * 返さないと、ダウンロード前に止まって二度と使えなかった)。1.5B は答えの形が崩れることがあるので、
 * 崩れた答えは出力の検査で捨て、構成は簡易の点数・演出テロップは提案なしで続くことを確かめる。
 */
afterEach(() => vi.unstubAllGlobals())

describe('GPU の無い PC のモデル', () => {
  it('GPU が無ければ 1.5B を選び、ダウンロードの前に止めない', () => {
    const m = chooseLocalModel(0, false)
    expect(m).toBe(CPU_LOCAL_MODEL)
    expect(m.uri).toBe('hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q4_K_M')
    expect(m.sizeGb).toBeLessThanOrEqual(CPU_SAFE_MODEL_GB)
    expect(
      judgeLocalModelLoad({
        gpu: false,
        vramTotalGb: 0,
        unifiedMemory: false,
        ramTotalGb: 8,
        modelGb: m.sizeGb,
        modelLabel: m.label
      }).ok
    ).toBe(true)
  })

  it('GPU があれば今までどおり(7B・14B)', () => {
    expect(chooseLocalModel(8, true).label).toBe('Qwen2.5 7B')
    expect(chooseLocalModel(24).label).toBe('Qwen2.5 14B')
  })
})

function scene(id: string, start: number, text: string): Scene {
  return {
    id,
    start,
    end: start + 30,
    speech: 20,
    lines: [{ id: `${id}-l`, speaker: 'A', start, end: start + 5, text, overlap: false }]
  }
}

/** このPCの AI の答え(1.5B が返しがちな崩れた形) */
function stubLocalAi(answers: unknown[] | Error): void {
  vi.stubGlobal('window', {
    api: {
      onLlmProgress: () => () => {},
      llmRun: async () => {
        if (answers instanceof Error) throw answers
        return answers
      }
    }
  })
}

const BROKEN: unknown[] = [
  'いや早すぎ!いや早すぎ!いや早すぎ!',
  { scenes: 'not an array', s1: 42 },
  [{ id: 'unknown-scene', verdict: 'highlight' }]
]

describe('1.5B の崩れた答えは捨てて簡易の判定で続ける', () => {
  const scenes = [scene('s1', 0, 'こんにちは、今日はロケです'), scene('s2', 30, 'うわー!すごい!')]
  const options = { provider: 'local' as const, apiKey: '', episodeName: '回', targetSec: 60 }

  it.each(BROKEN.map((b) => [JSON.stringify(b).slice(0, 30), b]))(
    '構成: 崩れた答え %s',
    async (_n, answer) => {
      stubLocalAi([answer])
      const { judgeScenes } = await import('../../src/renderer/src/lib/roughCutPlan')
      const r = await judgeScenes(scenes, 60, options)
      expect(r.source).toBe('heuristic')
      expect(r.judgements.map((j) => j.sceneId)).toEqual(['s1', 's2'])
    }
  )

  it('構成: 読み込めなかったときも簡易の点数で続け、理由を残す', async () => {
    stubLocalAi(new Error('このPCでは AI(Qwen2.5 1.5B)を読み込めませんでした'))
    const { judgeScenes } = await import('../../src/renderer/src/lib/roughCutPlan')
    const r = await judgeScenes(scenes, 60, options)
    expect(r.source).toBe('heuristic')
    expect(r.failure).toContain('読み込めませんでした')
  })

  it('演出テロップ: 崩れた答えからは提案を作らない(落ちない)', async () => {
    stubLocalAi([BROKEN[0]])
    const { proposeEffects } = await import('../../src/renderer/src/lib/roughCutPlan')
    const lines = [{ id: 'l1', speaker: 'A', text: 'うわー!', start: 3 }]
    for (const answer of BROKEN) {
      stubLocalAi([answer])
      const r = await proposeEffects(lines, {
        provider: 'local',
        apiKey: '',
        episodeName: '回'
      })
      expect(r.proposals).toEqual([])
      expect(r.total).toBe(1)
    }
  })
})

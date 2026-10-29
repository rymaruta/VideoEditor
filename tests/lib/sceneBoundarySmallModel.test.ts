import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildScenes } from '@shared/structure/scenes'
import { CPU_LOCAL_MODEL, localModelBillions, type LlmRequest } from '@shared/llm'
import { checkSceneBoundaries } from '@renderer/lib/roughCutPlan'
import { TRIAL4_TRANSCRIPT } from '../shared/fixtures/trial4Transcript'

/**
 * 区切りの確認(足し算の後段)は、このPCの AI が小さいモデル(GPU の無い PC の 1.5B)なら最初から頼まない。
 * 1.5B は答えの決まった例文で毎回外れ、何も直さずに工程が約 34 秒伸びるだけだった(試し編集 第4回の
 * 文字起こしで確かめ)。使うモデルは `llmPlan`(読み込まずに選び方だけ確かめる)から取る
 */

afterEach(() => vi.unstubAllGlobals())

const scenes = buildScenes(
  TRIAL4_TRANSCRIPT.map(([start, end, text], i) => ({
    id: `u${i}`,
    speaker: 'マイク1',
    start,
    end,
    text,
    overlap: false
  })),
  { start: 0, end: 660 }
)
const options = { provider: 'local' as const, apiKey: '' }

/** 区切りの前の発話が N4(「あとやはり我々は」)と例文の「話の途中」なら「話の途中」と答える偽物 */
function answer(r: LlmRequest): unknown {
  const head = r.prompt.split('──── ここ ────')[0]
  const all = [...head.matchAll(/「([^「」]*)」/gu)]
  const tail = all.length > 0 ? all[all.length - 1][1] : ''
  const cont = ['あとやはり我々は', 'この坂道を', 'スープが'].includes(tail)
  return { reason: '', answer: cont ? '話の途中' : '話の切れ目' }
}

function stub(plan: unknown, run: (reqs: LlmRequest[]) => unknown[]): ReturnType<typeof vi.fn> {
  const llmRun = vi.fn(async (reqs: LlmRequest[]) => run(reqs))
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v)
  })
  vi.stubGlobal('window', {
    api: {
      onLlmProgress: () => () => {},
      llmRun,
      ...(plan === undefined ? {} : { llmPlan: async () => plan })
    }
  })
  return llmRun
}

describe('小さいモデルでは区切りの確認を頼まない', () => {
  it('モデルの大きさを名前から読む', () => {
    expect(localModelBillions(CPU_LOCAL_MODEL.label)).toBe(1.5)
    expect(localModelBillions('Qwen2.5 7B')).toBe(7)
    expect(localModelBillions('Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M')).toBe(3)
    expect(localModelBillions('よく分からないモデル')).toBeNull()
  })

  it('1.5B(GPU の無い PC)なら AI を一度も呼ばずに省く(例文も聞かない)', async () => {
    const llmRun = stub({ model: CPU_LOCAL_MODEL.label, device: 'cpu' }, (r) => r.map(answer))
    const r = await checkSceneBoundaries(scenes, options)
    expect(llmRun).not.toHaveBeenCalled()
    expect(r).toMatchObject({
      moves: [],
      requests: 0,
      skipped: { reason: 'small-model', model: 'Qwen2.5 1.5B' }
    })
  })

  it('7B(GPU のある PC)なら今までどおり確かめて直す(第4回 N4)', async () => {
    const llmRun = stub({ model: 'Qwen2.5 7B', device: 'cuda' }, (r) => r.map(answer))
    const r = await checkSceneBoundaries(scenes, options)
    expect(llmRun).toHaveBeenCalled()
    expect(r.skipped).toBeUndefined()
    expect(r.moves).toHaveLength(1)
    expect(r.moves[0].at).toBeCloseTo(527.18, 2)
    expect(r.moves[0].to).toBeCloseTo(535.87, 2)
  })

  it('使うモデルが分からない(前の版・偽物に llmPlan が無い)なら今までどおり確かめる', async () => {
    const llmRun = stub(undefined, (r) => r.map(answer))
    await checkSceneBoundaries(scenes, options)
    expect(llmRun).toHaveBeenCalled()
  })

  it('例文を続けて外したモデルは、次から頼まない(通れば数え直す)', async () => {
    const biased = (r: LlmRequest[]): unknown[] => r.map(() => ({ reason: '', answer: '話の途中' }))
    const llmRun = stub({ model: 'Qwen2.5 7B', device: 'cuda' }, biased)
    for (let i = 0; i < 2; i++)
      expect((await checkSceneBoundaries(scenes, options)).untrusted).toBe('missed-control')
    const calls = llmRun.mock.calls.length
    const r = await checkSceneBoundaries(scenes, options)
    expect(llmRun.mock.calls.length).toBe(calls)
    expect(r.skipped).toEqual({ reason: 'missed-before', model: 'Qwen2.5 7B' })
  })

  it('Gemini は大きさを確かめずに頼む', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}'))
    )
    const llmRun = stub({ model: CPU_LOCAL_MODEL.label, device: 'cpu' }, (r) => r.map(answer))
    const r = await checkSceneBoundaries(scenes, { provider: 'gemini', apiKey: 'k' })
    expect(llmRun).not.toHaveBeenCalled()
    expect(r.skipped).toBeUndefined()
  })
})

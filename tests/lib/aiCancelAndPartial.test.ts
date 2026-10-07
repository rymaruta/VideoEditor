import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})
import { askAiJson } from '@renderer/lib/ai'
import { usePipelineStore } from '@renderer/store/pipelineStore'

describe('Gemini の答えの1件が壊れていても、ほかの件の答えは使う', () => {
  it('途中で切れた答えの件だけ答え無しにする', async () => {
    const answers = ['{"scenes":[{"id":"s1","score":80}]}', '{"scenes":[{"id":"s41","score":']
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = JSON.stringify({
          candidates: [{ content: { parts: [{ text: answers[n++] }] } }]
        })
        return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body }
      })
    )
    const r = await askAiJson('gemini', 'key', [
      { prompt: 'a', schema: {}, maxTokens: 10 },
      { prompt: 'b', schema: {}, maxTokens: 10 }
    ] as never)
    expect(r.results[0]).toEqual({ scenes: [{ id: 's1', score: 80 }] })
    expect(r.results[1]).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('自動編集の中止', () => {
  it('このPCの AI とノイズ除去にも中止を伝える', () => {
    const called: string[] = []
    const stub = (name: string) => () => {
      called.push(name)
      return Promise.resolve()
    }
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        syncCancel: stub('sync'),
        asrCancel: stub('asr'),
        eventsCancel: stub('events'),
        llmCancel: stub('llm'),
        denoiseCancel: stub('denoise')
      }
    }
    usePipelineStore.getState().cancel()
    expect(called.sort()).toEqual(['asr', 'denoise', 'events', 'llm', 'sync'])
  })
})

describe('仮編集の作り直しの中止', () => {
  it('動いていた工程を「中止しました」に戻し、済んだ工程(アングル)に失敗の印を付けない', async () => {
    const { useProjectStore } = await import('@renderer/store/projectStore')
    const stub = (): Promise<void> => Promise.resolve()
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        syncCancel: stub,
        asrCancel: stub,
        eventsCancel: stub,
        llmCancel: stub,
        denoiseCancel: stub,
        setBusyState: () => {},
        notifyDone: () => {},
        // 音の大きさを読んでいる間に「中止」を押す
        footageEnvelopes: async () => {
          usePipelineStore.getState().cancel()
          throw new Error('LLM_CANCELED')
        }
      }
    }
    useProjectStore.getState().newProject()
    useProjectStore.setState({
      project: {
        ...useProjectStore.getState().project,
        multicam: {
          anchorSourceId: 'cam',
          sources: [{ id: 'cam', name: 'カメラA', kind: 'camera' }],
          files: [{ assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: 30 }]
        }
      }
    })
    const steps = usePipelineStore.getState().steps
    usePipelineStore.setState({
      scenes: [{ id: 's1', start: 0, end: 30, lines: [], speech: 0 }],
      steps: { ...steps, angles: { state: 'done', percent: 100 } }
    })
    await usePipelineStore.getState().rebuildRoughCut()
    const after = usePipelineStore.getState().steps
    expect(after.angles.state).toBe('done')
    expect(after.cut).toMatchObject({ state: 'wait', note: '中止しました' })
    expect(Object.values(after).some((s) => s.state === 'run' || s.state === 'error')).toBe(false)
  })
})

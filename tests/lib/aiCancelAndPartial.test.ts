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

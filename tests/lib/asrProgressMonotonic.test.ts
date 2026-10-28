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
import { usePipelineStore } from '@renderer/store/pipelineStore'
import { runEpisode } from '../helpers/episodeHarness'

/**
 * 試し編集 第2回の不具合 8: 文字起こしの進み具合が 0% → 100% → 8% と戻った。モデルの準備(ダウンロード済みでも
 * 読み込みの知らせが 100% まで来る)の % を工程の % にしていたので、認識が始まると戻っていた
 */
describe('文字起こしの進み具合は戻らない', () => {
  it('モデルの準備の 100% の後に、認識の 1/12 で 8% へ戻らない', async () => {
    let listener: ((m: unknown) => void) | null = null
    const seen: number[] = []
    const unsub = usePipelineStore.subscribe((s, prev) => {
      const t = s.steps.transcribe
      if (t.state === 'run' && t.percent !== prev.steps.transcribe.percent) seen.push(t.percent)
    })
    await runEpisode(undefined, {
      onAsrProgress: (cb: (m: unknown) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
      asrRun: async (jobs: { id: string }[]) => {
        listener?.({ type: 'status', stage: 'load', percent: 0, note: 'モデルを準備中(CPU)' })
        listener?.({ type: 'status', stage: 'download', percent: 40, note: 'モデルを読み込み中' })
        listener?.({ type: 'status', stage: 'download', percent: 100, note: 'モデルを読み込み中' })
        listener?.({ type: 'device', device: 'cpu' })
        for (let i = 1; i <= jobs.length; i++)
          listener?.({ type: 'progress', done: i, total: jobs.length })
        return jobs.map((j) => ({
          id: j.id,
          text: 'こんにちは今日はよろしくお願いします',
          words: []
        }))
      }
    })
    unsub()
    expect(seen.length).toBeGreaterThan(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    // 準備の % は説明の方に出る
    expect(usePipelineStore.getState().steps.transcribe.state).toBe('done')
  })
})

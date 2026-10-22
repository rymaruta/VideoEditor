import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { LlmLoadFailures, LlmLoadTracker } from '@main/llmLoadFailures'

const dir = mkdtempSync(join(tmpdir(), 've-llmfail-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('読み込めなかった AI のモデルの記録', () => {
  it('覚えて次から試さず、「もう一度試す」で消せる', () => {
    const path = join(dir, 'a.json')
    const store = new LlmLoadFailures(path)
    expect(store.list()).toEqual([])
    store.add('hf:Qwen/7B', 'Qwen2.5 7B', new Date('2026-10-01T00:00:00Z'))
    store.add('hf:Qwen/7B', 'Qwen2.5 7B', new Date('2026-10-02T00:00:00Z'))
    expect(new LlmLoadFailures(path).list()).toEqual([
      { uri: 'hf:Qwen/7B', label: 'Qwen2.5 7B', at: '2026-10-02T00:00:00.000Z' }
    ])
    expect(store.has('hf:Qwen/7B')).toBe(true)
    expect(store.has('hf:Qwen/14B')).toBe(false)
    store.clear()
    expect(store.list()).toEqual([])
    expect(() => store.clear()).not.toThrow()
  })

  it('壊れたファイル・変な中身は記録なしとして扱う', () => {
    const path = join(dir, 'b.json')
    writeFileSync(path, '{broken')
    expect(new LlmLoadFailures(path).list()).toEqual([])
    writeFileSync(path, JSON.stringify([{ uri: 1 }, null, { uri: 'u', label: 'l', at: 't' }]))
    expect(new LlmLoadFailures(path).list()).toEqual([{ uri: 'u', label: 'l', at: 't' }])
  })
})

describe('読み込み中に落ちたかの見分け', () => {
  it('どのモデルかを知らせた後、読み込み終わりの前に落ちたら読み込めなかったモデル', () => {
    const t = new LlmLoadTracker()
    t.observe({ type: 'status', stage: 'download', percent: 40, note: '' })
    // ダウンロード中に落ちても、読み込めないモデルとはしない
    expect(t.loading()).toBeNull()
    t.observe({ type: 'device', device: 'cpu', model: 'Qwen2.5 7B', uri: 'hf:Qwen/7B' })
    t.observe({ type: 'status', stage: 'load', percent: 50, note: '' })
    expect(t.loading()).toEqual({ uri: 'hf:Qwen/7B', label: 'Qwen2.5 7B' })
    // 読み込み終わりの後(答えを作っている途中)に落ちたものは覚えない
    t.observe({ type: 'status', stage: 'load', percent: 100, note: '' })
    expect(t.loading()).toBeNull()
  })
})

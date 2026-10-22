import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { classifyLlmExit, LlmLoadFailures, LlmLoadTracker } from '@main/llmLoadFailures'
import { sameLoadEnv, type LlmLoadEnvStamp } from '@shared/llm'

const dir = mkdtempSync(join(tmpdir(), 've-llmfail-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const env: LlmLoadEnvStamp = { appVersion: '1.0.0', gpu: 'cpu', vramGb: 0, ramGb: 16 }

describe('読み込めなかった AI のモデルの記録', () => {
  it('覚えて、「もう一度試す」で消せる', () => {
    const path = join(dir, 'a.json')
    const store = new LlmLoadFailures(path)
    expect(store.list()).toEqual([])
    store.add('hf:Qwen/7B', 'Qwen2.5 7B', env, new Date('2026-10-01T00:00:00Z'))
    store.add('hf:Qwen/7B', 'Qwen2.5 7B', env, new Date('2026-10-02T00:00:00Z'))
    expect(new LlmLoadFailures(path).list()).toEqual([
      { uri: 'hf:Qwen/7B', label: 'Qwen2.5 7B', at: '2026-10-02T00:00:00.000Z', env }
    ])
    store.clear()
    expect(store.list()).toEqual([])
    expect(() => store.clear()).not.toThrow()
  })

  it('記録には環境を入れ、版・PC のメモリが変われば効かない', () => {
    const store = new LlmLoadFailures(join(dir, 'env.json'))
    store.add('hf:Qwen/7B', 'Qwen2.5 7B', env)
    expect(store.current('1.0.0', 16.2)).toHaveLength(1)
    expect(store.current('1.0.1', 16)).toEqual([])
    expect(store.current('1.0.0', 32)).toEqual([])
  })

  it('GPU の種類・GPU のメモリが変われば同じ環境ではない', () => {
    expect(sameLoadEnv(env, { ...env, ramGb: 16.3 })).toBe(true)
    expect(sameLoadEnv(env, { ...env, gpu: 'cuda' })).toBe(false)
    expect(sameLoadEnv(env, { ...env, vramGb: 8 })).toBe(false)
    expect(sameLoadEnv(env, { ...env, appVersion: '2.0.0' })).toBe(false)
  })

  it('壊れたファイル・環境の無い古い記録は記録なしとして扱う', () => {
    const path = join(dir, 'b.json')
    writeFileSync(path, '{broken')
    expect(new LlmLoadFailures(path).list()).toEqual([])
    writeFileSync(
      path,
      JSON.stringify([
        { uri: 1 },
        null,
        { uri: 'u', label: 'l', at: 't' },
        { uri: 'u2', label: 'l', at: 't', env }
      ])
    )
    expect(new LlmLoadFailures(path).list()).toEqual([{ uri: 'u2', label: 'l', at: 't', env }])
  })
})

describe('読み込み中に落ちたかの見分け', () => {
  it('どのモデルかを知らせた後、読み込み終わりの前に落ちたら読み込めなかったモデル', () => {
    const t = new LlmLoadTracker()
    t.observe({ type: 'status', stage: 'download', percent: 40, note: '' })
    expect(t.loading()).toBeNull()
    t.observe({
      type: 'device',
      device: 'cuda',
      model: 'Qwen2.5 7B',
      uri: 'hf:Qwen/7B',
      vramGb: 8
    })
    t.observe({ type: 'status', stage: 'load', percent: 50, note: '' })
    expect(t.loading()).toEqual({ uri: 'hf:Qwen/7B', label: 'Qwen2.5 7B', gpu: 'cuda', vramGb: 8 })
    t.observe({ type: 'status', stage: 'load', percent: 100, note: '' })
    expect(t.loading()).toBeNull()
  })
})

describe('解析のプロセスが答えずに終わったときの分かれ道', () => {
  it('中止 > 終了中 > 終了コード 0 > 異常終了 の順に見分ける', () => {
    expect(classifyLlmExit({ canceled: true, quitting: true, code: 9 })).toBe('canceled')
    // アプリの終了で閉じられた(will-quit の後に code 0 で来る)ものは、落ちたと扱わない
    expect(classifyLlmExit({ canceled: false, quitting: true, code: 0 })).toBe('quitting')
    expect(classifyLlmExit({ canceled: false, quitting: true, code: 1 })).toBe('quitting')
    expect(classifyLlmExit({ canceled: false, quitting: false, code: 0 })).toBe('clean')
    expect(classifyLlmExit({ canceled: false, quitting: false, code: 134 })).toBe('crashed')
    expect(classifyLlmExit({ canceled: false, quitting: false, code: -1 })).toBe('crashed')
  })
})

describe('終了中の印(取り消せる before-quit ではなく will-quit で立てる)', () => {
  it('before-quit(終了を取り消せる)では立てず、will-quit で立てる', async () => {
    const { EventEmitter } = await import('events')
    const { trackQuitting } = await import('@main/llmLoadFailures')
    const app = new EventEmitter()
    const isQuitting = trackQuitting(app)
    app.emit('before-quit')
    // 閉じる前の確認で取り消した: まだ終了中ではない(この後に落ちたモデルは覚える)
    expect(isQuitting()).toBe(false)
    app.emit('will-quit')
    expect(isQuitting()).toBe(true)
  })

  it('llmService は trackQuitting で配線し、before-quit では立てない', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'llmService.ts'), 'utf-8')
    expect(src).toMatch(/trackQuitting\(app\)/)
    expect(src).not.toMatch(/['"]before-quit['"]/)
    expect(src).toMatch(/quitting: isQuitting\(\)/)
  })
})

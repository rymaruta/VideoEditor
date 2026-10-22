import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  classifyLlmExit,
  deleteModelFiles,
  LlmLoadFailures,
  LlmLoadTracker
} from '@main/llmLoadFailures'
import {
  CPU_LOCAL_MODEL,
  pickLocalModel,
  sameLoadEnv,
  type LlmLoadEnvStamp,
  type LlmLoadFailure
} from '@shared/llm'

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

describe('使うモデルの選び方(4回目の監査)', () => {
  const gpuEnv: LlmLoadEnvStamp = { appVersion: '1.0.0', gpu: 'cuda', vramGb: 8, ramGb: 16 }
  const failure = (uri: string, e = gpuEnv): LlmLoadFailure => ({
    uri,
    label: 'x',
    at: 't',
    env: e
  })

  it('GPU のメモリで選んだ 7B が前に読み込めなかったら、使えなくせず 1.5B に下げる', () => {
    const pick = pickLocalModel({
      vramGb: 8,
      hasGpu: true,
      failures: [failure('hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M')],
      env: gpuEnv
    })
    expect(pick.kind).toBe('use')
    if (pick.kind !== 'use') return
    expect(pick.model).toBe(CPU_LOCAL_MODEL)
    expect(pick.note).toContain('Qwen2.5 7B を読み込めなかったため')
    expect(pick.note).toContain('軽いモデル')
  })

  it('1.5B も前に読み込めなかったら使わない', () => {
    const pick = pickLocalModel({
      vramGb: 8,
      hasGpu: true,
      failures: [failure('hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M'), failure(CPU_LOCAL_MODEL.uri)],
      env: gpuEnv
    })
    expect(pick).toEqual({ kind: 'skip', label: 'Qwen2.5 7B' })
  })

  it('GPU が無い PC は 1.5B のまま、「GPU が無いため軽いモデルを使います」と知らせる', () => {
    const cpuEnv = { ...gpuEnv, gpu: 'cpu', vramGb: 0 }
    const pick = pickLocalModel({ vramGb: 0, hasGpu: false, failures: [], env: cpuEnv })
    expect(pick).toEqual({
      kind: 'use',
      model: CPU_LOCAL_MODEL,
      note: 'GPU が無いため軽いモデル(Qwen2.5 1.5B)を使います'
    })
  })

  it('環境の違う記録は効かない(GPU を足した後は 7B を試す)', () => {
    const pick = pickLocalModel({
      vramGb: 8,
      hasGpu: true,
      failures: [failure('hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M', { ...gpuEnv, vramGb: 4 })],
      env: gpuEnv
    })
    expect(pick.kind === 'use' && pick.model.label).toBe('Qwen2.5 7B')
  })
})

describe('読み込めなかったモデルのファイルを消す(4回目の監査)', () => {
  it('置き場の中の .gguf を消し、分割したものは同じ組を全部消す。途中のファイルは触らない', () => {
    const cache = join(dir, 'models')
    mkdirSync(cache)
    for (const f of [
      'big-00001-of-00003.gguf',
      'big-00002-of-00003.gguf',
      'big-00003-of-00003.gguf',
      'other-00001-of-00002.gguf',
      'small.gguf',
      'small.gguf.ipull'
    ])
      writeFileSync(join(cache, f), 'x')
    expect(deleteModelFiles(join(cache, 'big-00001-of-00003.gguf'), cache).sort()).toEqual([
      'big-00001-of-00003.gguf',
      'big-00002-of-00003.gguf',
      'big-00003-of-00003.gguf'
    ])
    expect(deleteModelFiles(join(cache, 'small.gguf'), cache)).toEqual(['small.gguf'])
    expect(readdirSync(cache).sort()).toEqual(['other-00001-of-00002.gguf', 'small.gguf.ipull'])
  })

  it('置き場の外・.gguf でないものは消さない', () => {
    const outside = join(dir, 'outside.gguf')
    writeFileSync(outside, 'x')
    expect(deleteModelFiles(outside, join(dir, 'models'))).toEqual([])
    expect(deleteModelFiles(join(dir, 'models', 'small.gguf.ipull'), join(dir, 'models'))).toEqual(
      []
    )
    expect(readdirSync(dir)).toContain('outside.gguf')
  })

  it('読み込み中の知らせからファイルの場所を持つ', () => {
    const t = new LlmLoadTracker()
    t.observe({
      type: 'device',
      device: 'cuda',
      model: 'Qwen2.5 7B',
      uri: 'hf:x',
      vramGb: 8,
      path: '/m/x.gguf'
    })
    expect(t.loading()?.path).toBe('/m/x.gguf')
  })
})

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * このPCの AI のモデルを確かめる(`planLlm`)と、区切りの確認の頼み(`runLlm` の `recordLoadFailures: false`)。
 * - 中止(`cancelLlm`)で確かめのプロセスも止め、LLM_CANCELED を返す(前は null を返し、区切りの確認が
 *   そのまま進んでモデルを読み込んでいた)
 * - 確かめのプロセスが固まっても、上限時間で理由つきで終わる(前は構成の工程が止まった)
 * - 確かめの間も AI の頼みを「実行中」で断らない(前は `running` をふさいでいた)
 * - 区切りの確認で読み込みが落ちても「読み込めなかった」と覚えない(覚えると同じ回の場面の判定が 1.5B に下がる)
 */

const userData = mkdtempSync(join(tmpdir(), 've-llm-plan-'))

interface FakeChild {
  input: Record<string, unknown>
  send: (m: unknown) => boolean | void
  exit: (code: number, stderr: string) => void
  kill: ReturnType<typeof vi.fn>
}
const children: FakeChild[] = []

vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    getVersion: () => '9.9.9',
    on: () => undefined
  }
}))
vi.mock('../../src/main/llmWorker?modulePath', () => ({ default: 'llmWorker.js' }))
vi.mock('../../src/main/childRunner', () => ({
  runChild: (
    _path: string,
    input: Record<string, unknown>,
    onMessage: (m: unknown) => boolean | void,
    onExit: (code: number, stderr: string) => void
  ) => {
    const c: FakeChild = {
      input,
      send: onMessage,
      exit: onExit,
      kill: vi.fn(() => onExit(1, ''))
    }
    children.push(c)
    return { kill: c.kill }
  }
}))

beforeEach(() => {
  children.length = 0
  vi.resetModules()
})

describe('使うモデルを確かめる(planLlm)', () => {
  it('中止すると確かめのプロセスを止めて LLM_CANCELED', async () => {
    const svc = await import('../../src/main/llmService')
    const p = svc.planLlm()
    expect(children[0].input.planOnly).toBe(true)
    svc.cancelLlm()
    await expect(p).rejects.toThrow('LLM_CANCELED')
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('固まったら上限時間で止めて、理由つきで終わる', async () => {
    const svc = await import('../../src/main/llmService')
    await expect(svc.planLlm(30)).rejects.toThrow(/時間がかかりすぎました/u)
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('確かめの間も AI の頼みを断らない', async () => {
    const svc = await import('../../src/main/llmService')
    void svc.planLlm().catch(() => undefined)
    const run = svc.runLlm([], () => undefined)
    expect(children).toHaveLength(2)
    children[1].send({ type: 'done', results: [] })
    await expect(run).resolves.toEqual([])
  })

  it('選んだモデルを返し、次からは覚えたものを返す', async () => {
    const svc = await import('../../src/main/llmService')
    const p = svc.planLlm()
    children[0].send({ type: 'device', device: 'cpu', model: 'Qwen2.5 1.5B' })
    children[0].send({ type: 'done', results: [] })
    await expect(p).resolves.toEqual({ model: 'Qwen2.5 1.5B', device: 'cpu' })
    await expect(svc.planLlm()).resolves.toEqual({ model: 'Qwen2.5 1.5B', device: 'cpu' })
    expect(children).toHaveLength(1)
  })
})

describe('区切りの確認での読み込みの失敗は覚えない', () => {
  const crashWhileLoading = (c: FakeChild): void => {
    c.send({ type: 'device', device: 'cuda', model: 'Qwen2.5 7B', uri: 'hf:x/7b', vramGb: 8 })
    c.send({ type: 'status', stage: 'load', percent: 50, note: '' })
    c.exit(3, '')
  }

  it('recordLoadFailures: false なら覚えない', async () => {
    const svc = await import('../../src/main/llmService')
    svc.clearLlmLoadFailures()
    const run = svc.runLlm([], () => undefined, { recordLoadFailures: false })
    crashWhileLoading(children[0])
    await expect(run).rejects.toThrow()
    expect(svc.listLlmLoadFailures()).toEqual([])
  })

  it('ふつうの頼み(場面の判定)では今までどおり覚える', async () => {
    const svc = await import('../../src/main/llmService')
    svc.clearLlmLoadFailures()
    const run = svc.runLlm([], () => undefined)
    crashWhileLoading(children[0])
    await expect(run).rejects.toThrow()
    expect(svc.listLlmLoadFailures().map((f) => f.uri)).toEqual(['hf:x/7b'])
    svc.clearLlmLoadFailures()
  })
})

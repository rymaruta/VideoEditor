import { describe, expect, it } from 'vitest'
import {
  chooseLocalModel,
  judgeLocalModelLoad,
  loadCrashedMessage,
  skippedModelMessage,
  type LocalModelLoadEnv
} from '@shared/llm'

/**
 * このPCの AI は別プロセスで読み込むので、落ちても本体は落ちない。読み込む前に止めるのは
 * 「確実に読み込めない」ときだけにし、それ以外は試す(落ちたら覚えて次から試さない)。
 */
const base: LocalModelLoadEnv = {
  gpu: false,
  vramTotalGb: 0,
  unifiedMemory: false,
  ramTotalGb: 16,
  modelGb: 4.7,
  modelLabel: 'Qwen2.5 7B'
}

describe('このPCの AI を読み込む前に止めるか', () => {
  it('GPU が無くても、メモリが足りるなら止めない(試す)', () => {
    expect(judgeLocalModelLoad(base).ok).toBe(true)
    expect(judgeLocalModelLoad({ ...base, modelGb: chooseLocalModel(0).sizeGb }).ok).toBe(true)
  })

  it('Apple Silicon(GPU とメモリが共通)の 8GB でも 7B は止めない。空きメモリでは判断しない', () => {
    expect(
      judgeLocalModelLoad({
        ...base,
        gpu: 'metal',
        vramTotalGb: 5.3,
        unifiedMemory: true,
        ramTotalGb: 8
      }).ok
    ).toBe(true)
  })

  it('PC と GPU のメモリを合わせてもモデルより明らかに小さいときだけ止め、理由は場面を問わない一文', () => {
    const d = judgeLocalModelLoad({ ...base, ramTotalGb: 4 })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reason).toContain('このPCのメモリ(4.0GB)')
    expect(d.reason).toContain('Qwen2.5 7B')
    expect(d.reason).not.toContain('\n')
    // 「簡易の点数で続けます」などの続きは、呼び出し側(構成・演出テロップ)が場面に合わせて付ける
    expect(d.reason).not.toContain('簡易の点数')
    // 専用の GPU のメモリは足して数える(共通のメモリは二重に数えない)
    expect(judgeLocalModelLoad({ ...base, ramTotalGb: 4, gpu: 'cuda', vramTotalGb: 8 }).ok).toBe(
      true
    )
    expect(
      judgeLocalModelLoad({
        ...base,
        ramTotalGb: 4,
        gpu: 'metal',
        vramTotalGb: 3,
        unifiedMemory: true
      }).ok
    ).toBe(false)
  })

  it('落ちた・前に落ちたモデルの一文も、場面を問わない', () => {
    for (const text of [loadCrashedMessage('Qwen2.5 7B'), skippedModelMessage('Qwen2.5 7B')]) {
      expect(text).toContain('Qwen2.5 7B')
      expect(text).toContain('読み込め')
      expect(text).not.toContain('簡易の点数')
      expect(text).not.toContain('\n')
    }
    expect(skippedModelMessage('X')).toContain('もう一度試す')
  })
})

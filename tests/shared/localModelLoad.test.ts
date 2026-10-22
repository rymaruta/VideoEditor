import { describe, expect, it } from 'vitest'
import {
  chooseLocalModel,
  CPU_SAFE_MODEL_GB,
  judgeLocalModelLoad,
  LOCAL_MODELS,
  type LocalModelLoadEnv
} from '@shared/llm'

/**
 * このPCの AI は、GPU が無いと 3B 以上の読み込みで解析のプロセスが落ちた(Linux で確認)。
 * 読み込む前に GPU とメモリを確かめ、無理なら読み込まずに理由を一文で返す(呼び出し側は簡易の点数で続ける)。
 */
const base: LocalModelLoadEnv = {
  gpu: false,
  vramFreeGb: 0,
  ramFreeGb: 16,
  modelGb: 4.7,
  modelLabel: 'Qwen2.5 7B'
}

describe('このPCの AI を読み込んでよいか', () => {
  it('GPU が無いと、既定のモデル(7B)は読み込まない。理由は一文で、簡易の点数で続けると言う', () => {
    const d = judgeLocalModelLoad(base)
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reason).toContain('GPU が見つからず')
    expect(d.reason).toContain('Qwen2.5 7B')
    expect(d.reason).toContain('簡易の点数で続けます')
    expect(d.reason).not.toContain('\n')
  })

  it('GPU が無くても、落ちなかった大きさ(1.5B・約1GB)までは読み込む。3B(約2GB)は読み込まない', () => {
    expect(judgeLocalModelLoad({ ...base, modelGb: 1.0, modelLabel: '1.5B' }).ok).toBe(true)
    expect(judgeLocalModelLoad({ ...base, modelGb: 1.9, modelLabel: '3B' }).ok).toBe(false)
    expect(CPU_SAFE_MODEL_GB).toBeLessThan(1.9)
  })

  it('既定のモデルはどれも、GPU なしでは読み込まない(落ちる大きさ)', () => {
    for (const m of LOCAL_MODELS) expect(m.sizeGb).toBeGreaterThan(CPU_SAFE_MODEL_GB)
    expect(judgeLocalModelLoad({ ...base, modelGb: chooseLocalModel(0).sizeGb }).ok).toBe(false)
  })

  it('GPU に載るなら読み込む。載りきらない分が大きいと読み込まない', () => {
    expect(judgeLocalModelLoad({ ...base, gpu: 'cuda', vramFreeGb: 10 }).ok).toBe(true)
    // 14B(9GB)を空き 16GB の GPU に
    expect(
      judgeLocalModelLoad({ ...base, gpu: 'cuda', vramFreeGb: 16, modelGb: 9, modelLabel: '14B' })
        .ok
    ).toBe(true)
    // 空き 2GB の GPU に 7B: 残りの約3GB が CPU 側になる
    const d = judgeLocalModelLoad({ ...base, gpu: 'vulkan', vramFreeGb: 2 })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toContain('GPU の空きメモリ(2.0GB)')
    // 少しだけはみ出す(1GB 以内)なら読み込む
    expect(judgeLocalModelLoad({ ...base, gpu: 'cuda', vramFreeGb: 4.5 }).ok).toBe(true)
  })

  it('PC の空きメモリが足りないときも読み込まない', () => {
    const d = judgeLocalModelLoad({ ...base, modelGb: 1.0, ramFreeGb: 1.5, modelLabel: '1.5B' })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toContain('空きメモリ(1.5GB)')
    // GPU に全部載るなら、PC のメモリは余裕の分だけでよい
    expect(judgeLocalModelLoad({ ...base, gpu: 'cuda', vramFreeGb: 10, ramFreeGb: 1.2 }).ok).toBe(
      true
    )
  })
})

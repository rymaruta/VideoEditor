import { describe, expect, it } from 'vitest'
import { RendererCrashGuard } from '@main/rendererRecovery'

describe('RendererCrashGuard — 画面のプロセスが落ちたら読み込み直す(ただし止まらなくならない)', () => {
  it('たまに落ちるだけなら毎回読み込み直す', () => {
    const g = new RendererCrashGuard(2, 60_000)
    expect(g.shouldReload('oom', 0)).toBe(true)
    expect(g.shouldReload('crashed', 100_000)).toBe(true)
    expect(g.shouldReload('oom', 200_000)).toBe(true)
  })

  it('短い間に何度も落ちたら(開くたびに落ちる)、自動ではやり直さない', () => {
    const g = new RendererCrashGuard(2, 60_000)
    expect(g.shouldReload('crashed', 0)).toBe(true)
    expect(g.shouldReload('crashed', 1_000)).toBe(true)
    expect(g.shouldReload('crashed', 2_000)).toBe(false)
    // 期間を過ぎれば、また読み込み直す
    expect(g.shouldReload('crashed', 200_000)).toBe(true)
  })

  it('正常に閉じたときは読み込み直さない', () => {
    expect(new RendererCrashGuard().shouldReload('clean-exit', 0)).toBe(false)
  })
})

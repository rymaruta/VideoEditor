import { describe, expect, it } from 'vitest'
import {
  createEtaTracker,
  formatRemaining,
  noteStage,
  remainingMs
} from '../../src/renderer/src/lib/eta'

describe('残り時間の目安', () => {
  it('ここまでの進み方から見積もる(始まった直後・進みが小さいうちは出さない)', () => {
    expect(remainingMs(0, 25, 60_000)).toBe(180_000)
    expect(remainingMs(0, 25, 3_000)).toBeNull()
    expect(remainingMs(0, 5, 60_000)).toBeNull()
    expect(remainingMs(undefined, 50, 60_000)).toBeNull()
    expect(remainingMs(0, 100, 60_000)).toBeNull()
  })

  it('分・時間で出す', () => {
    expect(formatRemaining(30_000)).toBe('まもなく')
    expect(formatRemaining(180_000)).toBe('残り約3分')
    expect(formatRemaining(3_900_000)).toBe('残り約1時間5分')
    expect(formatRemaining(7_200_000)).toBe('残り約2時間')
  })
})

describe('工程ごとの起点', () => {
  it('起点の進み具合から数える(途中から数え始めても 0→100 と決めつけない)', () => {
    // 40% から 60% まで 60 秒 → 残り 40% は 120 秒
    expect(remainingMs(0, 60, 60_000, 40)).toBe(120_000)
    // 起点から 10% 進むまでは出さない
    expect(remainingMs(0, 45, 60_000, 40)).toBeNull()
  })

  it('段階が変わって進み具合が 0 に戻ったら、そこから数え直す', () => {
    const eta = createEtaTracker()
    const startedAt = 0
    expect(eta.estimate('cut', { startedAt, percent: 0, note: '読み込み中' }, 0)).toBeNull()
    // 読み込みが 10 秒で 100% まで
    eta.estimate('cut', { startedAt, percent: 90, note: '読み込み中' }, 9_000)
    // 解析が 0% から始まる。全体の 0→100 と見ると「すぐ終わる」と出てしまう
    expect(eta.estimate('cut', { startedAt, percent: 0, note: '解析中' }, 10_000)).toBeNull()
    // 解析は 20 秒で 20% → 残り 80% は 80 秒
    expect(eta.estimate('cut', { startedAt, percent: 20, note: '解析中' }, 30_000)).toBe(80_000)
  })

  it('同じ段階で進み具合が戻ったときも取り直す', () => {
    const eta = createEtaTracker()
    eta.estimate('a', { startedAt: 0, percent: 0 }, 0)
    expect(eta.estimate('a', { startedAt: 0, percent: 50 }, 50_000)).toBe(50_000)
    eta.estimate('a', { startedAt: 0, percent: 10 }, 60_000)
    expect(eta.estimate('a', { startedAt: 0, percent: 30 }, 80_000)).toBe(70_000)
  })

  it('数字だけ変わるメモは同じ段階として扱う', () => {
    expect(noteStage('3/10 枚の画')).toBe(noteStage('4/10 枚の画'))
    expect(noteStage('読み込み中')).not.toBe(noteStage('解析中'))
    const eta = createEtaTracker()
    eta.estimate('c', { startedAt: 0, percent: 0, note: '0/10 枚の画' }, 0)
    expect(eta.estimate('c', { startedAt: 0, percent: 50, note: '5/10 枚の画' }, 50_000)).toBe(
      50_000
    )
  })

  it('メモがすでに「残り」を出していれば二重に出さない', () => {
    const eta = createEtaTracker()
    eta.estimate('t', { startedAt: 0, percent: 0, note: '0/10' }, 0)
    expect(
      eta.estimate('t', { startedAt: 0, percent: 50, note: '5/10 · 残り約 3 分' }, 50_000)
    ).toBeNull()
  })

  it('新しい回(startedAt が変わった)では前の回の起点を使わない', () => {
    const eta = createEtaTracker()
    eta.estimate('r', { startedAt: 0, percent: 0 }, 0)
    eta.estimate('r', { startedAt: 0, percent: 80 }, 80_000)
    eta.estimate('r', { startedAt: 100_000, percent: 80 }, 100_000)
    expect(eta.estimate('r', { startedAt: 100_000, percent: 90 }, 110_000)).toBe(10_000)
  })
})

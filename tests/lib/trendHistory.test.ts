import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareTrend, loadTrendHistory, saveTrendSnapshot } from '@renderer/lib/trendHistory'
import { NASTY_VALUES } from '../helpers/boundary'

const store = new Map<string, string>()
const STORAGE_KEY = 've-game-trend-history'

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('compareTrend — 前回との比較', () => {
  it('履歴が無ければ比較できない', () => {
    expect(compareTrend(['A'])).toBeNull()
  })

  it('前回に無かったものが「新規」、あったものが「継続」', () => {
    saveTrendSnapshot(['A', 'B'])
    const result = compareTrend(['B', 'C'])
    expect(result?.newGames).toEqual(['C'])
    expect(result?.sustainedGames).toEqual(['B'])
  })

  it('【この回の主題】表記が揺れただけの同じゲームを「新規」にしない', () => {
    // 判定するのは生成AIなので、前回「Apex Legends」・今回「【APEX LEGENDS】」(全角空白入り)と
    // 書き分けられる。生の文字列で突き合わせると**毎回「新規」**になり、
    // 「新規」という表示自体が当てにならなくなっていた。
    saveTrendSnapshot(['Apex Legends'])
    const result = compareTrend(['【APEX　LEGENDS】'])
    expect(result?.newGames).toEqual([])
    // 画面に出す名前は今回の表記のまま
    expect(result?.sustainedGames).toEqual(['【APEX　LEGENDS】'])
  })

  it('同じゲームが2回入っていても1回だけ数える', () => {
    saveTrendSnapshot(['A'])
    const result = compareTrend(['B', '【B】'])
    expect(result?.newGames).toEqual(['B'])
  })

  it('比較の対象は「最後の1回」', () => {
    saveTrendSnapshot(['A'])
    saveTrendSnapshot(['B'])
    expect(compareTrend(['A'])?.newGames).toEqual(['A'])
  })

  it('壊れた履歴・壊れた入力でも落ちない', () => {
    store.set(STORAGE_KEY, '[null,{"timestamp":1},{"gameNames":["A"]},"x"]')
    expect(() => compareTrend(['A'])).not.toThrow()
    store.set(STORAGE_KEY, JSON.stringify([{ timestamp: 1, gameNames: [null, 1, 'A'] }]))
    expect(compareTrend(['A'])?.sustainedGames).toEqual(['A'])
    for (const v of NASTY_VALUES) {
      expect(() => compareTrend(v as string[])).not.toThrow()
    }
  })

  it('読めない保存内容は空の履歴として扱う', () => {
    store.set(STORAGE_KEY, '{壊れたJSON')
    expect(loadTrendHistory()).toEqual([])
    expect(compareTrend(['A'])).toBeNull()
  })
})

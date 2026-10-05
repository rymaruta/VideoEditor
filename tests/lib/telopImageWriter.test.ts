import { describe, expect, it } from 'vitest'
import { TelopImageWriter } from '@renderer/lib/telopImageWriter'

/**
 * 書き出しのテロップの層の画像を、同じ中身は1枚にまとめ、数 MB ずつ main へ送る。
 * 送り先は差し替えて、届いた番号・束の大きさ・送っている最中の束の数を数える。
 */
function fakeStage(delayMs = 0): {
  stage: { append: (id: string, first: number, images: Uint8Array[]) => Promise<void> }
  calls: { first: number; sizes: number[] }[]
  maxInFlight: () => number
} {
  const calls: { first: number; sizes: number[] }[] = []
  let inFlight = 0
  let max = 0
  return {
    calls,
    maxInFlight: () => max,
    stage: {
      append: async (_id, first, images) => {
        inFlight++
        max = Math.max(max, inFlight)
        calls.push({ first, sizes: images.map((b) => b.byteLength) })
        await new Promise((r) => setTimeout(r, delayMs))
        inFlight--
      }
    }
  }
}

const img = (n: number, fill: number): Uint8Array => new Uint8Array(n).fill(fill)

describe('TelopImageWriter — 画像を少しずつ、同じ中身はまとめて送る', () => {
  it('中身が同じ画像には同じ番号を返し、送るのは1回だけ', async () => {
    const f = fakeStage()
    const w = new TelopImageWriter(f.stage, 's', 1 << 20)
    expect(await w.add(img(10, 0))).toBe(0)
    expect(await w.add(img(10, 1))).toBe(1)
    expect(await w.add(img(10, 0))).toBe(0)
    // 長さだけ違う(中身の先頭が同じ)ものは別物
    expect(await w.add(img(11, 0))).toBe(2)
    await w.finish()
    expect(w.count).toBe(3)
    expect(f.calls).toEqual([{ first: 0, sizes: [10, 10, 11] }])
  })

  it('決めた量ごとに束にして送り、番号は束をまたいで続く', async () => {
    const f = fakeStage()
    const w = new TelopImageWriter(f.stage, 's', 250)
    for (let i = 0; i < 7; i++) await w.add(img(100, i))
    await w.finish()
    expect(f.calls).toEqual([
      { first: 0, sizes: [100, 100, 100] },
      { first: 3, sizes: [100, 100, 100] },
      { first: 6, sizes: [100] }
    ])
  })

  it('送っている束は1つだけ(main が遅くても、溜まるのは束2つぶんまで)', async () => {
    const f = fakeStage(5)
    const w = new TelopImageWriter(f.stage, 's', 100)
    for (let i = 0; i < 10; i++) await w.add(img(100, i))
    await w.finish()
    expect(f.calls).toHaveLength(10)
    expect(f.maxInFlight()).toBe(1)
  })

  it('送りの失敗は次に待ったときに伝わる(黙って欠けた層で書き出さない)', async () => {
    const w = new TelopImageWriter(
      { append: () => Promise.reject(new Error('disk full')) },
      's',
      10
    )
    await w.add(img(10, 1))
    await expect(w.finish()).rejects.toThrow('disk full')
  })

  it('中止したら溜めているぶんは送らない', async () => {
    const f = fakeStage()
    const w = new TelopImageWriter(f.stage, 's', 1 << 20)
    await w.add(img(10, 1))
    await w.abandon()
    await w.finish()
    expect(f.calls).toEqual([])
  })
})

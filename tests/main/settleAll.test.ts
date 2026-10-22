import { describe, expect, it } from 'vitest'
import { allSettledOrThrow } from '@main/settleAll'

describe('allSettledOrThrow', () => {
  it('全部が成り立てば Promise.all と同じ並びの値', async () => {
    await expect(allSettledOrThrow([Promise.resolve(1), Promise.resolve('a')])).resolves.toEqual([
      1,
      'a'
    ])
  })

  it('失敗があっても、遅い残りが終わるまで返らない(最初の失敗を投げる)', async () => {
    let slowDone = false
    const slow = new Promise<number>((r) =>
      setTimeout(() => {
        slowDone = true
        r(2)
      }, 50)
    )
    const err = await allSettledOrThrow([Promise.reject(new Error('先の失敗')), slow]).catch(
      (e: Error) => e
    )
    expect((err as Error).message).toBe('先の失敗')
    expect(slowDone).toBe(true)
  })
})

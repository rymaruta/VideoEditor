import { describe, expect, it } from 'vitest'
import { MediaJobQueue } from '../../src/main/mediaJobQueue'

/** 手で終わらせられる仕事 */
function controllable(): {
  run: () => Promise<string>
  finish: (v: string) => void
  started: () => boolean
} {
  let resolve: (v: string) => void = () => {}
  let started = false
  return {
    run: () => {
      started = true
      return new Promise<string>((r) => (resolve = r))
    },
    finish: (v) => resolve(v),
    started: () => started
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('MediaJobQueue', () => {
  it('同時に走らせるのは決めた数まで。待ちは新しい頼みから片付ける', async () => {
    const q = new MediaJobQueue<string>(2)
    const jobs = [0, 1, 2, 3].map(() => controllable())
    const results = jobs.map((j, i) => q.request(`k${i}`, j.run))
    await flush()
    expect(jobs.map((j) => j.started())).toEqual([true, true, false, false])
    jobs[0].finish('a')
    await flush()
    // 空いた1枠には、後から来た k3 が先に入る
    expect(jobs.map((j) => j.started())).toEqual([true, true, false, true])
    jobs[1].finish('b')
    jobs[3].finish('d')
    await flush()
    jobs[2].finish('c')
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('同じ頼みは1回にまとめ、終わった結果は覚えておく', async () => {
    const q = new MediaJobQueue<string>(1)
    let calls = 0
    const run = async (): Promise<string> => {
      calls++
      return 'x'
    }
    expect(await Promise.all([q.request('same', run), q.request('same', run)])).toEqual(['x', 'x'])
    expect(await q.request('same', run)).toBe('x')
    expect(calls).toBe(1)
  })

  it('待ちが多すぎたら、一番古い頼みを捨てる', async () => {
    const q = new MediaJobQueue<string>(1, 2)
    const first = controllable()
    void q.request('running', first.run)
    const old = q.request('old', async () => 'old')
    const mid = q.request('mid', async () => 'mid')
    const newest = q.request('new', async () => 'new')
    await expect(old).rejects.toThrow('MEDIA_JOB_DROPPED')
    first.finish('r')
    expect(await newest).toBe('new')
    expect(await mid).toBe('mid')
    expect(q.waiting).toBe(0)
  })

  it('失敗した頼みは覚えず、次は作り直す', async () => {
    const q = new MediaJobQueue<string>(1)
    let n = 0
    const run = async (): Promise<string> => {
      n++
      if (n === 1) throw new Error('boom')
      return 'ok'
    }
    await expect(q.request('k', run)).rejects.toThrow('boom')
    expect(await q.request('k', run)).toBe('ok')
  })

  it('仕事が同期的に投げても枠を返し、以後の頼みが止まらない', async () => {
    const q = new MediaJobQueue<string>(1)
    const boom = (): Promise<string> => {
      throw new Error('ENOSPC')
    }
    await expect(q.request('a', boom)).rejects.toThrow('ENOSPC')
    await expect(q.request('b', boom)).rejects.toThrow('ENOSPC')
    expect(await q.request('c', async () => 'ok')).toBe('ok')
    expect(await q.request('a', async () => 'again')).toBe('again')
  })

  it('覚えておく結果は大きさの合計でも抑え、古く使っていないものから捨てる', async () => {
    // 長い作業で拡大した波形・大きなフレームが溜まり続けないように
    const q = new MediaJobQueue<string>(1, 64, 500, 10)
    let calls = 0
    const make = (v: string) => async (): Promise<string> => {
      calls++
      return v
    }
    await q.request('a', make('aaaa'))
    await q.request('b', make('bbbb'))
    // a を使ったので、次に溢れたとき捨てるのは b
    await q.request('a', make('aaaa'))
    await q.request('c', make('cccc'))
    expect(q.cachedBytes).toBe(8)
    calls = 0
    await q.request('a', make('aaaa'))
    await q.request('c', make('cccc'))
    expect(calls).toBe(0)
    await q.request('b', make('bbbb'))
    expect(calls).toBe(1)
    // 1つで上限を超えるものは覚えない(ほかを巻き添えに捨てない)
    await q.request('huge', make('x'.repeat(11)))
    expect(q.cachedBytes).toBeLessThanOrEqual(10)
    calls = 0
    await q.request('huge', make('x'.repeat(11)))
    expect(calls).toBe(1)
  })
})

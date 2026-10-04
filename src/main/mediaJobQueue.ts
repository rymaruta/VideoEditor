/**
 * タイムラインの絵(音の波形・サムネイル)を作る ffmpeg の、同時に走らせる数を抑える。
 *
 * 長尺の回でシークすると、タイムラインに新しく見えたクリップの波形が一度に頼まれ、
 * ffmpeg が 10 本同時に走って画面のスレッドまで CPU を取られていた
 * (実測: 30分の回でシークのたびに画面が 1〜2.3 秒止まった。4コアの PC)。
 *
 * - 同時に走らせるのは `concurrency` 本まで。待っている頼みは**新しいものから**片付ける
 *   (シークした先、いま見えているクリップの絵が先に出る)
 * - 同じ頼みの結果は覚えておく(行き来しても作り直さない)。同時に来た同じ頼みは1回にまとめる
 * - 待ちが `maxPending` を超えたら、一番古い頼みを捨てる(スクロールで通り過ぎたクリップの分)
 */
export class MediaJobQueue<T> {
  private running = 0
  private readonly pending: { key: string; run: () => Promise<T> }[] = []
  private readonly waiters = new Map<
    string,
    { resolve: (v: T) => void; reject: (e: unknown) => void }[]
  >()
  private readonly cache = new Map<string, T>()

  constructor(
    private readonly concurrency = 2,
    private readonly maxPending = 64,
    private readonly cacheSize = 500
  ) {}

  /** `key` が同じ頼みは同じ結果になること */
  request(key: string, run: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit !== undefined) {
      // 使ったものを新しい側へ(古いものから捨てる)
      this.cache.delete(key)
      this.cache.set(key, hit)
      return Promise.resolve(hit)
    }
    return new Promise<T>((resolve, reject) => {
      const list = this.waiters.get(key)
      if (list) {
        list.push({ resolve, reject })
        return
      }
      this.waiters.set(key, [{ resolve, reject }])
      this.pending.push({ key, run })
      while (this.pending.length > this.maxPending) {
        const dropped = this.pending.shift()!
        this.settle(dropped.key, (w) => w.reject(new Error('MEDIA_JOB_DROPPED')))
      }
      this.pump()
    })
  }

  /** 待っている数(試験・記録用) */
  get waiting(): number {
    return this.pending.length
  }

  private settle(
    key: string,
    fn: (w: { resolve: (v: T) => void; reject: (e: unknown) => void }) => void
  ): void {
    const list = this.waiters.get(key) ?? []
    this.waiters.delete(key)
    for (const w of list) fn(w)
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      // 新しい頼みから
      const job = this.pending.pop()!
      this.running++
      job
        .run()
        .then(
          (value) => {
            this.cache.set(job.key, value)
            while (this.cache.size > this.cacheSize)
              this.cache.delete(this.cache.keys().next().value as string)
            this.settle(job.key, (w) => w.resolve(value))
          },
          (e) => this.settle(job.key, (w) => w.reject(e))
        )
        .finally(() => {
          this.running--
          this.pump()
        })
    }
  }
}

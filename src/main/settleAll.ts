/**
 * `Promise.all` と同じ値(または最初の失敗)を返すが、**失敗があっても全部が終わるまで待つ**。
 *
 * 同じ素材を開く子プロセス(ffprobe・ffmpeg)を並べて走らせるときに使う。`Promise.all` は1本が
 * 失敗した時点で返るので、残りの子プロセスは素材を開いたまま走り続ける。Windows では開いている
 * ファイルは消せない・名前を変えられないので、失敗の直後に利用者が素材を消す・置き換える・
 * 書き出しで上書きすると「使用中」で失敗していた(実測: 動画でないファイルの試聴用素材作りが
 * 1本目の ffprobe の失敗で返ったとき、2本目の ffprobe がまだ素材を開いていた)
 */
export async function allSettledOrThrow<T extends readonly unknown[] | []>(
  tasks: T
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const results = await Promise.allSettled(tasks)
  for (const r of results) if (r.status === 'rejected') throw r.reason
  return results.map((r) => (r as PromiseFulfilledResult<unknown>).value) as {
    -readonly [K in keyof T]: Awaited<T[K]>
  }
}

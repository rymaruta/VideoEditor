/**
 * 「重い初期化を1回だけ走らせて使い回す」キャッシュ。ただし**失敗は覚えない**。
 *
 * `let p; if (!p) p = load(); return p` と素直に書くと、失敗した Promise まで
 * そのまま残る。すると原因(接続断など)を直して押し直しても、キャッシュ済みの
 * 失敗が即座に返るだけで**二度と読み込みを試みない**。アプリを再起動するまで
 * 直らないので、利用者からは機能が壊れたように見える。
 *
 * - 進行中は同じ Promise を返す(連打しても実際の読み込みは1本)
 * - 失敗が確定したら捨てる(次の呼び出しでやり直す)
 * - 成功したら以後ずっと使い回す
 */
export function retryableSingleton<T>(load: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null
  return () => {
    if (current) return current
    // `load()` が同期的に投げても Promise の失敗として扱えるようにする
    const guarded: Promise<T> = (async () => load())().catch((e) => {
      // 自分が入れたものだけ捨てる。すでに次の読み込みが始まっていたら触らない
      if (current === guarded) current = null
      throw e
    })
    current = guarded
    return guarded
  }
}

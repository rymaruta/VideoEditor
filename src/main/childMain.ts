/**
 * 別プロセス(Electron の utilityProcess)で動く処理の入口。
 *
 * onnxruntime のようなネイティブのアドオンは、1つのプロセスの中で別のスレッドから2回目に読み込むと
 * 「Module did not self-register」で使えなくなる(実測: 文字起こしの後に顔の検出を別スレッドで動かすと失敗)。
 * そこで、ネイティブのアドオンを使う処理はスレッドではなくプロセスを分ける。
 * 起動時の入力は最初のメッセージで受け取る。
 */
interface ParentPortLike {
  once(event: 'message', listener: (e: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

export function childMain<T>(
  run: (input: T, post: (message: unknown) => void) => Promise<void>
): void {
  const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  if (!port) throw new Error('utilityProcess の中で動かしてください')
  port.once('message', (e) => {
    const post = (m: unknown): void => port.postMessage(m)
    run(e.data as T, post).catch((err: unknown) =>
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    )
  })
}

import { formatIpcError } from './ipcError'

/**
 * 外部リンクをブラウザで開く。**開けなかったら画面に出す。**
 *
 * これまで `onClick={() => window.api.openExternal(url)}` と**戻り値を捨てて**呼んで
 * いたので、main が投げても受け取る人がおらず、押しても何も起きないまま終わっていた。
 * 開く経路は4箇所(YouTubeトレンド・ゲームトレンド・BGM/効果音のライセンス×2)あり、
 * 4箇所とも同じ形だったので、**受け取り方をここ1つにまとめる**
 * (各画面に書き写すと、あとで片方にだけ案内が育つ)。
 *
 * `onError` は各画面が既に持っているエラー表示に渡す。成功したときは**触らない**
 * ——別の操作で出ている案内を、リンクを開いただけで消さないため。
 */
export async function openExternalLink(
  url: string,
  onError: (message: string) => void
): Promise<void> {
  try {
    await window.api.openExternal(url)
  } catch (e) {
    onError(formatIpcError(e))
  }
}

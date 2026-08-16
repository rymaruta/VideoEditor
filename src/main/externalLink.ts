/**
 * 外部リンク(ブラウザで開くURL)を開けるかどうかの判定と、開けないときの日本語。
 *
 * **`shell.openExternal` は「開けたか」を教えてくれない。** ブラウザを起こす手段が無い
 * 環境で呼ぶと、ログには `LaunchProcess: failed to execvp: xdg-open` が出てリンクは
 * 開かないのに、**戻り値は成功**で解決する(実測: `unhandledrejection` 0回・画面のエラー
 * 要素も 0 → 0)。つまり呼び出し側に `catch` を足しても1文字も出ない——
 * 押しても何も起きず、理由も出ない、が利用者に見えるすべてだった。
 *
 * `shell.openPath` のときは `existsSync` という**こちらで確かめられる前提条件**が
 * あった。URL にも同じものを探すと2つある:
 *   1. **URL の形**(`http` / `https` 以外は Electron が開かない)
 *   2. **開く手立てがあるか**(Linux は `xdg-open` が無ければ開けない)
 * どちらも呼ぶ前に分かるので、分かる範囲は先に日本語で知らせる。
 * 分からない範囲(手立てはあるが実際には開かなかった)は**依然として知りようがない**ので、
 * そこは正直に「開いたはず」として扱う。
 */

/** ブラウザで開いてよい scheme。`file:` や `javascript:` をここから開かせない。 */
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:'])

/** Linux でブラウザを起こすのに使うコマンド。Electron が内部で呼ぶものと同じ。 */
export const LINUX_OPENER_COMMAND = 'xdg-open'

export function isOpenableUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.trim() === '') return false
  try {
    return OPENABLE_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * 開く前に分かる問題を日本語で返す(問題が無ければ `null`)。
 *
 * `hasOpener` は **Linux でだけ**意味を持つ。Windows と macOS は OS 自身が
 * 既定のブラウザを開くので、コマンドの有無を調べる先が無い。
 *
 * URL は**そのまま文に入れる**。開けないと分かった時点で利用者にできることは
 * 「自分でブラウザに貼る」だけなので、貼る物を出さない案内は役に立たない。
 */
export function openExternalProblem(
  url: string,
  platform: NodeJS.Platform,
  hasOpener: boolean
): string | null {
  if (!isOpenableUrl(url)) {
    return 'このリンクは開けません(http または https のアドレスだけを開けます)'
  }
  if (platform === 'linux' && !hasOpener) {
    return `ブラウザを開けませんでした。次のアドレスをブラウザに貼り付けて開いてください: ${url}`
  }
  return null
}

/**
 * `shell.openExternal` 自体が投げたときの日本語。
 *
 * ここへ来るのは**開く手立てはあるのに断られた**ときだけ(不正なURL・保護された scheme)。
 * 見慣れない原因は捨てずに1行へ畳んで残す——ただしそれを「日本語化した」とは数えない。
 */
export function describeOpenExternalFailure(url: string, e: unknown): Error {
  const raw = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim()
  const detail = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
  const tail = detail ? ` (${detail})` : ''
  return new Error(
    `ブラウザを開けませんでした。次のアドレスをブラウザに貼り付けて開いてください: ${url}${tail}`
  )
}

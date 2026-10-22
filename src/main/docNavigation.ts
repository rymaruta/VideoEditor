import { pathToFileURL } from 'url'

export type DocNavigation =
  { action: 'allow' } | { action: 'external'; url: string } | { action: 'deny' }

/** # 以降を外し、Windows のドライブ文字(file:///C:/…)の大小をそろえる */
function normalizeFileUrl(u: string): string {
  const i = u.indexOf('#')
  const base = i < 0 ? u : u.slice(0, i)
  return base.replace(
    /^file:\/\/\/([A-Za-z])(:|%3A)/i,
    (_m, d: string) => `file:///${d.toLowerCase()}:`
  )
}

/**
 * ライセンス表記の窓の中で、リンクを押したときの扱い。
 * - `allow`: 開いている文書そのもの(# 以降の目次の移動だけ)。`file:` の URL が同じときだけ
 *   (Windows のドライブ文字の大小は区別しない)
 * - `external`: https のリンク(http は https に上げる)。窓の中では開かず、既定のブラウザで開く
 * - `deny`: それ以外(ほかのファイル・javascript: ・https に上げられない http など)
 */
export function docNavigation(url: string, docPath: string): DocNavigation {
  if (normalizeFileUrl(url) === normalizeFileUrl(pathToFileURL(docPath).href))
    return { action: 'allow' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { action: 'deny' }
  }
  if (parsed.protocol === 'https:') return { action: 'external', url: parsed.href }
  if (parsed.protocol === 'http:') {
    // https に上げる。上げられない(ポートが 80 以外・名前が無い・資格情報付き)ものは開かない
    if (
      !parsed.hostname ||
      (parsed.port && parsed.port !== '80') ||
      parsed.username ||
      parsed.password
    )
      return { action: 'deny' }
    parsed.protocol = 'https:'
    parsed.port = ''
    return { action: 'external', url: parsed.href }
  }
  return { action: 'deny' }
}

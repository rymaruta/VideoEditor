import { pathToFileURL } from 'url'

/**
 * ライセンス表記の窓の中で、リンクを押したときの扱い。
 * - `allow`: 開いている文書そのもの(# 以降の目次の移動だけ)。`file:` の URL が完全に同じときだけ
 * - `external`: https のリンク。窓の中では開かず、既定のブラウザで開く
 * - `deny`: それ以外(ほかのファイル・http・javascript: など)
 */
export function docNavigation(url: string, docPath: string): 'allow' | 'external' | 'deny' {
  const withoutHash = (u: string): string => {
    const i = u.indexOf('#')
    return i < 0 ? u : u.slice(0, i)
  }
  if (withoutHash(url) === withoutHash(pathToFileURL(docPath).href)) return 'allow'
  try {
    if (new URL(url).protocol === 'https:') return 'external'
  } catch {
    return 'deny'
  }
  return 'deny'
}

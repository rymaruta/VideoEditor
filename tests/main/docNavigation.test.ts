import { join } from 'path'
import { pathToFileURL } from 'url'
import { describe, expect, it } from 'vitest'
import { docNavigation } from '@main/docNavigation'

/** ライセンス表記の窓の中のリンク: 同じ文書の目次だけ移動し、https は外のブラウザ、ほかは止める */
describe('ライセンス表記の窓のリンク', () => {
  const doc = join(__dirname, 'resources', 'LICENSES.chromium.html')
  const href = pathToFileURL(doc).href

  it('同じ文書(# 以降の目次の移動)だけ許す', () => {
    expect(docNavigation(`${href}#license-1`, doc)).toEqual({ action: 'allow' })
    expect(docNavigation(href, doc)).toEqual({ action: 'allow' })
  })

  it('名前の終わりが同じだけの別のファイル・別の場所は許さない', () => {
    expect(docNavigation('file:///tmp/evil/LICENSES.chromium.html', doc).action).toBe('deny')
    expect(docNavigation(`${href}.html`, doc).action).toBe('deny')
    expect(docNavigation(`${href}?x=LICENSES.chromium.html`, doc).action).toBe('deny')
  })

  it('Windows のドライブ文字の大小は区別しない(C: と c:)', () => {
    const winDoc = 'C:\\Program Files\\App\\resources\\LICENSES.chromium.html'
    const lower = 'file:///c:/Program%20Files/App/resources/LICENSES.chromium.html#x'
    const upper = 'file:///C:/Program%20Files/App/resources/LICENSES.chromium.html'
    // pathToFileURL は Windows 以外では C:\ を相対のパスとみるので、比べる相手の形を直接作る
    const nav = (u: string): string =>
      docNavigation(
        u,
        process.platform === 'win32'
          ? winDoc
          : '/C:/Program Files/App/resources/LICENSES.chromium.html'
      ).action
    expect(nav(lower)).toBe('allow')
    expect(nav(upper)).toBe('allow')
    expect(nav('file:///d:/Program%20Files/App/resources/LICENSES.chromium.html')).toBe('deny')
  })

  it('https は外のブラウザで開き、http は https に上げて開く', () => {
    expect(docNavigation('https://source.chromium.org/chromium', doc)).toEqual({
      action: 'external',
      url: 'https://source.chromium.org/chromium'
    })
    expect(docNavigation('http://www.apache.org/licenses/LICENSE-2.0', doc)).toEqual({
      action: 'external',
      url: 'https://www.apache.org/licenses/LICENSE-2.0'
    })
  })

  it('https に上げられない http・javascript: などは止める', () => {
    expect(docNavigation('http://example.com:8080/', doc).action).toBe('deny')
    expect(docNavigation('http://user:pw@example.com/', doc).action).toBe('deny')
    expect(docNavigation('javascript:alert(1)', doc).action).toBe('deny')
    expect(docNavigation('not a url', doc).action).toBe('deny')
  })
})

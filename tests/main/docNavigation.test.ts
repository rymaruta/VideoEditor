import { join } from 'path'
import { pathToFileURL } from 'url'
import { describe, expect, it } from 'vitest'
import { docNavigation } from '@main/docNavigation'

/** ライセンス表記の窓の中のリンク: 同じ文書の目次だけ移動し、https は外のブラウザ、ほかは止める */
describe('ライセンス表記の窓のリンク', () => {
  const doc = join(__dirname, 'resources', 'LICENSES.chromium.html')
  const href = pathToFileURL(doc).href

  it('同じ文書(# 以降の目次の移動)だけ許す', () => {
    expect(docNavigation(`${href}#license-1`, doc)).toBe('allow')
    expect(docNavigation(href, doc)).toBe('allow')
  })

  it('名前の終わりが同じだけの別のファイル・別の場所は許さない', () => {
    expect(docNavigation('file:///tmp/evil/LICENSES.chromium.html', doc)).toBe('deny')
    expect(docNavigation(`${href}.html`, doc)).toBe('deny')
    expect(docNavigation(`${href}?x=LICENSES.chromium.html`, doc)).toBe('deny')
  })

  it('https は外のブラウザで開き、http・javascript: などは止める', () => {
    expect(docNavigation('https://source.chromium.org/chromium', doc)).toBe('external')
    expect(docNavigation('http://example.com/', doc)).toBe('deny')
    expect(docNavigation('javascript:alert(1)', doc)).toBe('deny')
    expect(docNavigation('not a url', doc)).toBe('deny')
  })
})

import { describe, expect, it } from 'vitest'
import { ABOUT_NOTE, aboutLines, isLicenseDoc } from '@shared/about'

describe('バージョン情報(アプリの中のダイアログ)', () => {
  it('見出しは製品名と版、部品の版は 1 行に', () => {
    expect(
      aboutLines({
        product: 'VideoEditor',
        version: '1.2.3',
        electron: '39.8.10',
        chrome: '142.0',
        node: '22.1.0'
      })
    ).toEqual({
      title: 'VideoEditor 1.2.3',
      runtime: 'Electron 39.8.10 / Chromium 142.0 / Node.js 22.1.0'
    })
  })
  it('ライセンスの案内の文言を残す(前の確認の窓と同じ)', () => {
    expect(ABOUT_NOTE).toContain('FFmpeg(GPL)')
    expect(ABOUT_NOTE).toContain('「サードパーティのライセンス」「Chromium のライセンス」')
  })
  it('画面から来た文書の名前は、知っているものだけ開く', () => {
    expect(isLicenseDoc('notices')).toBe(true)
    expect(isLicenseDoc('chromium')).toBe(true)
    expect(isLicenseDoc('../etc/passwd')).toBe(false)
    expect(isLicenseDoc(undefined)).toBe(false)
  })
})

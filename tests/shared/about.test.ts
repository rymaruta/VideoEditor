import { describe, expect, it } from 'vitest'
import { ABOUT_NOTE, aboutLines, isLicenseDoc, sourceOfferView } from '@shared/about'

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
  it('ライセンスの案内: オープンソースの表記とソースの入手方法を案内する', () => {
    expect(ABOUT_NOTE).toContain('FFmpeg(GPL)')
    expect(ABOUT_NOTE).toContain('「オープンソースの表記」「Chromium のライセンス」')
    expect(ABOUT_NOTE).toContain('「ソースの入手方法」')
  })
  it('ソースの入手方法: 連絡先が無ければ入手先の URL だけを案内する(書面による申し出は出さない)', () => {
    for (const vendorEmail of ['', undefined, 'TBD', 'noreply@example.invalid']) {
      const v = sourceOfferView({
        vendor: 'VideoEditor',
        vendorEmail,
        url: 'https://github.com/rymaruta/VideoEditor/releases'
      })
      const text = v.paragraphs.join('\n')
      expect(text).toContain(
        '同梱の FFmpeg の対応するソース一式は、https://github.com/rymaruta/VideoEditor/releases の各版のリリースから入手できます(版ごとに置いています)。'
      )
      expect(text).not.toContain('3 年間')
      expect(text).not.toContain('媒体での請求')
      expect(text).not.toContain('@')
      expect(v.url).toBe('https://github.com/rymaruta/VideoEditor/releases')
      expect(v.email).toBeNull()
    }
  })
  it('ソースの入手方法: 連絡先があれば入手先・連絡先と 3 年間(書面による申し出)を出す', () => {
    const v = sourceOfferView({
      vendor: '山田映像合同会社',
      vendorEmail: 'support@vendor.co.jp',
      url: 'https://vendor.co.jp/oss/'
    })
    const text = v.paragraphs.join('\n')
    expect(text).toContain('3 年間')
    expect(text).toContain('入手先: https://vendor.co.jp/oss/')
    expect(text).toContain('support@vendor.co.jp')
    expect(v.url).toBe('https://vendor.co.jp/oss/')
    expect(v.email).toBe('support@vendor.co.jp')
  })
  it('ソースの入手方法: 未定(TBD・example の宛先)は「(未定)」と出し、開く先を持たない', () => {
    const v = sourceOfferView({ vendor: 'TBD', vendorEmail: 'noreply@example.invalid', url: 'TBD' })
    const text = v.paragraphs.join('\n')
    expect(text).toContain('入手先: (未定)')
    expect(text).not.toContain('example.invalid')
    expect(v.url).toBeNull()
    const withEmail = sourceOfferView({ vendor: 'TBD', vendorEmail: 'a@vendor.co.jp', url: 'TBD' })
    expect(withEmail.paragraphs.join('\n')).toContain('入手先: (未定)')
    expect(withEmail.url).toBeNull()
    expect(sourceOfferView(undefined).url).toBeNull()
  })
  it('画面から来た文書の名前は、知っているものだけ開く', () => {
    expect(isLicenseDoc('notices')).toBe(true)
    expect(isLicenseDoc('chromium')).toBe(true)
    expect(isLicenseDoc('../etc/passwd')).toBe(false)
    expect(isLicenseDoc(undefined)).toBe(false)
  })
})

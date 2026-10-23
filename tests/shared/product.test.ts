import { readdirSync, readFileSync, statSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  APP_ID,
  isPlaceholder,
  PRODUCT_DESCRIPTION,
  PRODUCT_NAME,
  PRODUCT_VENDOR,
  PRODUCT_VENDOR_EMAIL,
  SOURCE_OFFER_URL
} from '@shared/product'
import { buildMenuTemplate } from '@shared/appMenu'

const root = join(__dirname, '..', '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as Record<string, unknown>
const builder = createRequire(__filename)(join(root, 'electron-builder.cjs')) as Record<
  string,
  unknown
> & {
  win: { executableName: string }
  linux: { maintainer: string }
  mac: { extendInfo: Record<string, string> }
  asarUnpack: string[]
}

describe('製品の身元は product.json の1か所から', () => {
  it('製品名は Tsunagi(product.json から読む)', () => {
    const json = JSON.parse(readFileSync(join(root, 'src/shared/product.json'), 'utf-8')) as Record<
      string,
      string
    >
    expect(PRODUCT_NAME).toBe('Tsunagi')
    expect(PRODUCT_NAME).toBe(json.name)
    expect(PRODUCT_VENDOR_EMAIL).toBe(json.vendorEmail)
    expect(SOURCE_OFFER_URL).toBe(json.sourceOfferUrl)
    // 販売者・ソースの入手先は持ち主が決めるまで未定(配布用のビルドは scripts/release-check.cjs が止める)
    expect(typeof json.sourceOfferUrl).toBe('string')
  })

  it('画面・main のコードに古い製品名を直書きしない(PRODUCT_NAME を使う)', () => {
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(tsx?|css|html)$/.test(name) && /VideoEditor/.test(readFileSync(p, 'utf-8')))
          hits.push(p.slice(root.length + 1))
      }
    }
    walk(join(root, 'src'))
    expect(hits).toEqual([])
  })

  it('未定の値(TBD・空・example の宛先)を見分ける', () => {
    for (const v of ['TBD', 'tbd', '', '  ', 'noreply@example.invalid', 'https://example.com/x'])
      expect(isPlaceholder(v)).toBe(true)
    for (const v of ['山田映像合同会社', 'support@vendor.co.jp', 'https://vendor.co.jp/oss/'])
      expect(isPlaceholder(v)).toBe(false)
  })

  it('インストーラの名前・ID は product.json のもの', () => {
    expect(builder.productName).toBe(PRODUCT_NAME)
    expect(builder.win.executableName).toBe(PRODUCT_NAME)
    expect(builder.appId).toBe(APP_ID)
    // appId は変えない(変えると別のアプリとして入る)
    expect(APP_ID).toBe('com.videoeditor.app')
  })

  it('package.json の説明・販売者が product.json と食い違わない', () => {
    expect(pkg.description).toBe(PRODUCT_DESCRIPTION)
    expect((pkg.author as { name: string }).name).toBe(PRODUCT_VENDOR)
    expect(builder.linux.maintainer).toContain(PRODUCT_VENDOR)
    expect(pkg.license).toBeTruthy()
  })

  it('package.json に productName を置かない(置くと設定・自動保存の置き場が変わる)', () => {
    expect(pkg.productName).toBeUndefined()
    expect(pkg.name).toBe('video-editor')
  })

  it('窓の題名・メニューも製品名から', () => {
    const html = readFileSync(join(root, 'src/renderer/index.html'), 'utf-8')
    expect(html).toContain('<title>%PRODUCT_NAME%</title>')
    expect(buildMenuTemplate({}, [], { isDev: false, isMac: true })[0].label).toBe(PRODUCT_NAME)
  })

  it('mac の利用目的は日本語と英語の両方で書く', () => {
    const info = builder.mac.extendInfo
    expect(Object.keys(info).length).toBeGreaterThan(0)
    for (const text of Object.values(info)) {
      expect(text).toMatch(/[ぁ-んァ-ン一-龥]/)
      expect(text).toMatch(/Used to /)
    }
  })

  it('ネイティブの部品・同梱の資源は asar の外に置く(元の yml と同じ)', () => {
    expect(builder.asarUnpack).toEqual(
      expect.arrayContaining([
        'resources/**',
        'node_modules/ffmpeg-static/**',
        'node_modules/ffprobe-static/**',
        'node_modules/onnxruntime-node/**',
        'node_modules/node-llama-cpp/**',
        'node_modules/@node-llama-cpp/**',
        'node_modules/sharp/**',
        'node_modules/@img/**'
      ])
    )
  })
})

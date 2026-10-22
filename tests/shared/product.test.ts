import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { APP_ID, PRODUCT_DESCRIPTION, PRODUCT_NAME, PRODUCT_VENDOR } from '@shared/product'
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

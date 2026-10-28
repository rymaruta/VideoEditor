import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { isPlaceholder as appIsPlaceholder } from '@shared/product'

const root = join(__dirname, '..', '..')
const req = createRequire(__filename)
const check = req(join(root, 'scripts', 'release-check.cjs')) as {
  isPlaceholder: (v: unknown) => boolean
  releaseProblems: (p: Record<string, unknown>) => string[]
  isDistributionBuild: (targets: unknown) => boolean
  assertReleasable: (dir: string) => void
  linuxMaintainer: (p: Record<string, unknown>) => string
}
const builder = req(join(root, 'electron-builder.cjs')) as {
  beforePack: (context: unknown) => void
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>
}

const decided = {
  vendor: '山田映像合同会社',
  vendorEmail: 'support@vendor.co.jp',
  sourceOfferUrl: 'https://vendor.co.jp/oss/'
}

describe('配布用のビルドの検査(販売者・ソースの入手先。連絡先は任意)', () => {
  it('決まっていれば通す', () => {
    expect(check.releaseProblems(decided)).toEqual([])
  })

  it('連絡先(vendorEmail)が無くても、販売者とソースの入手先が決まっていれば通す', () => {
    const withoutEmail = { vendor: decided.vendor, sourceOfferUrl: decided.sourceOfferUrl }
    expect(check.releaseProblems(withoutEmail)).toEqual([])
    for (const vendorEmail of ['', '  ', 'TBD', 'noreply@example.invalid'])
      expect(check.releaseProblems({ ...decided, vendorEmail })).toEqual([])
  })

  it('TBD のままなら、どれが未定かを挙げて止める(連絡先の未定では止めない)', () => {
    const problems = check.releaseProblems({
      vendor: 'TBD',
      vendorEmail: 'noreply@example.invalid',
      sourceOfferUrl: 'TBD'
    })
    expect(problems).toHaveLength(2)
    expect(problems.join('\n')).toMatch(/vendor/)
    expect(problems.join('\n')).not.toMatch(/vendorEmail/)
    expect(problems.join('\n')).toMatch(/sourceOfferUrl/)
  })

  it('欠けた項目・形の違う値も止める(連絡先は書いてあるときだけメールの形かを見る)', () => {
    expect(check.releaseProblems({})).toHaveLength(2)
    expect(check.releaseProblems({ ...decided, sourceOfferUrl: '' })[0]).toMatch(/sourceOfferUrl/)
    expect(check.releaseProblems({ ...decided, vendorEmail: 'support' })[0]).toMatch(/メール/)
    expect(check.releaseProblems({ ...decided, vendorEmail: 'support@vendor' })[0]).toMatch(
      /メール/
    )
    expect(
      check.releaseProblems({ ...decided, sourceOfferUrl: 'http://vendor.co.jp/' })[0]
    ).toMatch(/https/)
  })

  it('未定の判定はアプリ側(product.ts)と同じ', () => {
    for (const v of [
      'TBD',
      '',
      ' tbd ',
      'noreply@example.invalid',
      'a@example.com',
      'https://example.com/auto-updates',
      'https://sub.example.org/',
      '山田映像合同会社',
      'support@vendor.co.jp',
      'https://vendor.co.jp/oss/',
      'https://notexample.com/'
    ])
      expect(check.isPlaceholder(v)).toBe(appIsPlaceholder(v))
  })

  it('--dir(展開しただけ)は開発用、それ以外の出力は配布用', () => {
    expect(check.isDistributionBuild([{ name: 'dir' }])).toBe(false)
    expect(check.isDistributionBuild([])).toBe(false)
    expect(check.isDistributionBuild(undefined)).toBe(false)
    expect(check.isDistributionBuild([{ name: 'nsis' }])).toBe(true)
    expect(check.isDistributionBuild([{ name: 'dir' }, { name: 'dmg' }])).toBe(true)
  })

  it('いまの product.json(連絡先なし・入手先は GitHub の Releases)は配布してよい', () => {
    const product = JSON.parse(
      readFileSync(join(root, 'src', 'shared', 'product.json'), 'utf-8')
    ) as Record<string, string>
    expect(product.vendorEmail).toBe('')
    expect(check.releaseProblems(product)).toEqual([])
    expect(() => check.assertReleasable(root)).not.toThrow()
  })

  it('未定の product.json なら配布用の出力の前で止まる(beforePack が配布用の出力で検査を掛ける)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-check-'))
    try {
      mkdirSync(join(dir, 'src', 'shared'), { recursive: true })
      writeFileSync(
        join(dir, 'src', 'shared', 'product.json'),
        JSON.stringify({ vendor: 'TBD', vendorEmail: '', sourceOfferUrl: 'TBD' })
      )
      expect(() => check.assertReleasable(dir)).toThrow(/配布用のビルドを止めました/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // いまの product.json は通るので、beforePack を実際に呼ぶと表記の生成まで走る。ここでは配線だけを確かめる
    expect(typeof builder.beforePack).toBe('function')
    const src = readFileSync(join(root, 'electron-builder.cjs'), 'utf-8')
    expect(src).toMatch(
      /isDistributionBuild\(context && context\.targets\)[^\n]*\n\s*assertReleasable\(__dirname\)/
    )
  })

  it('linux の maintainer: 連絡先があればメール、無ければ製品の URL', () => {
    expect(check.linuxMaintainer(decided)).toBe('山田映像合同会社 <support@vendor.co.jp>')
    expect(
      check.linuxMaintainer({
        ...decided,
        vendorEmail: '',
        homepage: 'https://github.com/rymaruta/VideoEditor'
      })
    ).toBe('山田映像合同会社 <https://github.com/rymaruta/VideoEditor>')
    // homepage も無ければソースの入手先
    expect(check.linuxMaintainer({ ...decided, vendorEmail: undefined })).toBe(
      '山田映像合同会社 <https://vendor.co.jp/oss/>'
    )
  })

  it('配布用の npm のビルドは先に検査し、開発用(build・build:unpack・build:win:test)は検査しない', () => {
    for (const s of ['build:win', 'build:mac', 'build:linux'])
      expect(pkg.scripts[s].startsWith('node scripts/release-check.cjs && ')).toBe(true)
    for (const s of ['build', 'build:unpack', 'build:win:test'])
      expect(pkg.scripts[s]).not.toContain('release-check')
    expect(pkg.scripts['build:win:test']).toContain('--dir')
  })
})

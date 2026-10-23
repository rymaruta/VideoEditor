import { readFileSync } from 'fs'
import { createRequire } from 'module'
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

describe('配布用のビルドの検査(販売者・連絡先・ソースの入手先)', () => {
  it('決まっていれば通す', () => {
    expect(check.releaseProblems(decided)).toEqual([])
  })

  it('TBD・example の宛先のままなら、どれが未定かを挙げて止める', () => {
    const problems = check.releaseProblems({
      vendor: 'TBD',
      vendorEmail: 'noreply@example.invalid',
      sourceOfferUrl: 'TBD'
    })
    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toMatch(/vendor/)
    expect(problems.join('\n')).toMatch(/vendorEmail/)
    expect(problems.join('\n')).toMatch(/sourceOfferUrl/)
  })

  it('欠けた項目・形の違う値も止める', () => {
    expect(check.releaseProblems({})).toHaveLength(3)
    expect(check.releaseProblems({ ...decided, vendorEmail: 'support' })[0]).toMatch(/メール/)
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

  it('いまの product.json(販売者が未定)では配布用の出力の前で止まり、--dir は止まらない', () => {
    expect(() => check.assertReleasable(root)).toThrow(/配布用のビルドを止めました/)
    expect(() => builder.beforePack({ targets: [{ name: 'nsis' }] })).toThrow(
      /配布用のビルドを止めました/
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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildNotices,
  collectPackages,
  licenseOf,
  productRoots,
  renderNotices,
  sourceOf
} from '../../scripts/third-party-notices.mjs'

const tmp = mkdtempSync(join(tmpdir(), 've-notices-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function pkg(dir: string, json: Record<string, unknown>, files: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
}

describe('ライセンス表記の生成: 依存の集め方', () => {
  const root = join(tmp, 'project')
  const nm = join(root, 'node_modules')
  pkg(root, {
    name: 'app',
    dependencies: { a: '1', '@x/font': '1' },
    optionalDependencies: { 'not-installed': '1' },
    devDependencies: { react: '1', vitest: '1' }
  })
  pkg(
    join(nm, 'a'),
    { name: 'a', version: '1.0.0', license: 'MIT', dependencies: { b: '2' } },
    {
      LICENSE: 'MIT a text\r\n',
      'index.js': '// not a license'
    }
  )
  // a は入れ子の b@2 を使い、c は上の b@1 を使う
  pkg(join(nm, 'a', 'node_modules', 'b'), { name: 'b', version: '2.0.0', license: 'ISC' })
  pkg(join(nm, 'b'), { name: 'b', version: '1.0.0', licenses: [{ type: 'BSD-2-Clause' }] })
  pkg(join(nm, '@x', 'font'), {
    name: '@x/font',
    version: '5.0.0',
    license: 'OFL-1.1',
    repository: { url: 'git+https://github.com/x/font.git' },
    dependencies: { c: '1' },
    optionalDependencies: { 'missing-optional': '1' }
  })
  pkg(
    join(nm, 'c'),
    { name: 'c', version: '1.0.0', license: { type: 'Apache-2.0' }, dependencies: { b: '1' } },
    {
      NOTICE: 'c notice',
      'LICENSE.txt': 'apache text'
    }
  )
  pkg(join(nm, 'react'), { name: 'react', version: '19.0.0', license: 'MIT' }, { LICENSE: 'react' })
  pkg(join(nm, 'vitest'), { name: 'vitest', version: '3.0.0', license: 'MIT' })

  it('製品の依存と、画面に取り込まれる react だけを出発点にする(試験の道具は入れない)', () => {
    const roots = productRoots({
      dependencies: { a: '1' },
      devDependencies: { react: '1', vitest: '1' }
    })
    expect(roots).toEqual(['a', 'react'])
  })

  it('入れ子の node_modules も Node と同じ順で探し、版の違う同名を両方載せる', () => {
    const { packages, missing } = collectPackages(root, [
      'a',
      '@x/font',
      'not-installed-but-optional-root'
    ])
    const ids = packages.map((p) => `${p.name}@${p.version}`)
    expect(ids).toEqual(['@x/font@5.0.0', 'a@1.0.0', 'b@1.0.0', 'b@2.0.0', 'c@1.0.0'])
    // 入っていない optional は飛ばし、必要なのに無いものは知らせる
    expect(missing).toEqual(['not-installed-but-optional-root((製品) が使う)'])
  })

  it('LICENSE・NOTICE の全文を集め、コードは集めない。改行は LF にそろえる', () => {
    const { packages } = collectPackages(root, ['a', '@x/font'])
    const a = packages.find((p) => p.name === 'a')!
    expect(a.files).toEqual([{ file: 'LICENSE', text: 'MIT a text' }])
    const c = packages.find((p) => p.name === 'c')!
    expect(c.files.map((f) => f.file)).toEqual(['LICENSE.txt', 'NOTICE'])
    expect(c.license).toBe('Apache-2.0')
  })

  it('license 欄の古い書き方・ソースの場所を読む', () => {
    expect(licenseOf({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] })).toBe('MIT OR Apache-2.0')
    expect(licenseOf({})).toBe('(記載なし)')
    expect(sourceOf({ repository: 'git+https://github.com/a/b.git' })).toBe(
      'https://github.com/a/b'
    )
    expect(sourceOf({ repository: { url: 'git@github.com:a/b.git' } })).toBe(
      'https://github.com/a/b'
    )
    expect(sourceOf({ homepage: 'https://example.org' })).toBe('https://example.org')
  })
})

describe('ライセンス表記の生成: 文書', () => {
  const text = renderNotices({
    productName: 'Prod',
    productVersion: '9.9.9',
    packages: [
      {
        name: '@fontsource/kosugi-maru',
        version: '5.3.0',
        license: 'Apache-2.0',
        source: 's',
        author: '',
        files: [{ file: 'LICENSE', text: 'APACHE' }]
      },
      {
        name: 'libfoo',
        version: '1.0.0',
        license: 'LGPL-3.0-or-later',
        source: 'https://example.org/libfoo',
        author: '',
        files: []
      },
      {
        name: 'nofile',
        version: '1.0.0',
        license: 'MIT',
        source: '',
        author: 'Someone',
        files: [],
        standardText: 'MIT Someone'
      }
    ],
    ffmpeg: {
      ffmpeg: { version: 'ffmpeg version 7', readme: 'README', license: 'GPL3 TEXT' },
      ffprobe: { version: 'ffprobe version 4' }
    },
    electron: { version: '39.0.0', license: 'ELECTRON MIT' },
    models: [{ name: 'Model', bundled: false, license: 'MIT', source: 'https://hf' }]
  })

  it('FFmpeg が GPL であることと、ソースの入手先を書く', () => {
    expect(text).toContain('GPL-3.0-or-later')
    expect(text).toContain('https://ffmpeg.org/download.html#get-sources')
    expect(text).toContain('ffmpeg version 7')
    expect(text).toContain('ffprobe version 4')
    expect(text).toContain('GPL3 TEXT')
  })

  it('Electron・Chromium・モデル・フォントの欄がある', () => {
    expect(text).toContain('Electron 39.0.0')
    expect(text).toContain('LICENSES.chromium.html')
    expect(text).toContain('ELECTRON MIT')
    expect(text).toMatch(/- Model\n\s+初回に取得 \/ ライセンス: MIT/)
    expect(text).toContain('- @fontsource/kosugi-maru 5.3.0  Apache-2.0')
  })

  it('コピーレフトの部品を拾ってソースの場所を示し、全文の無い部品は標準の文面か、そう書く', () => {
    expect(text).toContain('- libfoo@1.0.0  LGPL-3.0-or-later  ソース: https://example.org/libfoo')
    expect(text).toContain('全文のファイルが含まれていません。ライセンスは LGPL-3.0-or-later')
    expect(text).toContain('MIT の標準の文面に package.json の作者を入れたもの')
    expect(text).toContain('MIT Someone')
  })
})

describe('ライセンス表記の生成: このプロジェクト', () => {
  // node_modules を読むだけ(ffmpeg -version を1回ずつ走らせる)
  const { text, packages, missing } = buildNotices(join(__dirname, '..', '..'))

  it('同梱する依存がすべて見つかり、試験の道具は入らない', () => {
    expect(missing).toEqual([])
    const names = new Set(packages.map((p) => p.name))
    for (const n of [
      'ffmpeg-static',
      'node-llama-cpp',
      '@huggingface/transformers',
      'react',
      'zustand'
    ])
      expect(names.has(n)).toBe(true)
    for (const n of ['vitest', 'electron-builder', 'eslint', 'typescript'])
      expect(names.has(n)).toBe(false)
  })

  it('フォントは 9 つが OFL-1.1、Kosugi Maru が Apache-2.0', () => {
    const fonts = packages.filter((p) => p.name.startsWith('@fontsource/'))
    expect(fonts).toHaveLength(10)
    expect(fonts.filter((f) => f.license === 'OFL-1.1')).toHaveLength(9)
    expect(fonts.find((f) => f.name === '@fontsource/kosugi-maru')?.license).toBe('Apache-2.0')
    for (const f of fonts) expect(f.files.length).toBeGreaterThan(0)
  })

  it('ffmpeg の GPL・モデルの表記が入り、全文の無い部品が残らない', () => {
    expect(text).toContain('GNU GENERAL PUBLIC LICENSE')
    expect(text).toContain('Copyright (c) 2020 Shiqi Yu')
    expect(text).toContain('whisper-large-v3-turbo')
    expect(text).toContain('Qwen2.5')
    expect(text).not.toContain('全文のファイルが含まれていません。')
  })
})

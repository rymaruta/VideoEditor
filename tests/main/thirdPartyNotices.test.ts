import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildNotices,
  collectPackages,
  licenseOf,
  productRoots,
  renderNotices,
  sourceOf,
  sourceOfferLines
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
    // 同じビルドと分からない ffprobe には「同じビルド」と書かない
    expect(text).not.toContain('ffmpeg と同じビルド')
    expect(text).toContain('@derhuerst/ffprobe-static')
    expect(text).not.toContain('joshwnj/ffprobe-static')
  })

  it('ffprobe が ffmpeg と同じビルドなら、そう書く(ソースも同じ)', () => {
    const same = renderNotices({
      productName: 'App',
      productVersion: '1.0.0',
      packages: [],
      ffmpeg: {
        ffmpeg: { version: 'ffmpeg version 7.0.2', readme: '', license: 'GPL3 TEXT' },
        ffprobe: { version: 'ffprobe version 7.0.2', sameBuild: true }
      },
      electron: { version: '39.0.0', license: '' },
      models: []
    })
    expect(same).toContain('ffprobe は上の ffmpeg と同じビルドで、対応するソースも同じです')
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
  const { text, packages, missing, problems, chromiumLicenses } = buildNotices(
    join(__dirname, '..', '..')
  )

  it('表記に欠けが無く(ffmpeg を実行でき、GPL・Electron・Chromium の表記がある)、Chromium の表記の場所を正しく書く', () => {
    expect(problems).toEqual([])
    expect(existsSync(chromiumLicenses)).toBe(true)
    expect(text).toContain('app.asar.unpacked/resources/')
    expect(text).not.toContain('実行ファイルと同じフォルダ')
  })

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

  it('フォントは 11 個が OFL-1.1(画面の Geist 2 つを含む)、Kosugi Maru が Apache-2.0', () => {
    const fonts = packages.filter((p) => p.name.startsWith('@fontsource/'))
    expect(fonts).toHaveLength(12)
    expect(fonts.filter((f) => f.license === 'OFL-1.1')).toHaveLength(11)
    for (const n of ['@fontsource/geist-sans', '@fontsource/geist-mono'])
      expect(fonts.find((f) => f.name === n)?.license).toBe('OFL-1.1')
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

describe('ライセンス表記の生成: 欠けたまま作らない', () => {
  it('ffmpeg.LICENSE が無い・ffmpeg を実行できない・Chromium の表記が無いと、欠けとして挙げる', () => {
    const root = join(tmp, 'broken')
    pkg(root, { name: 'app', version: '1.0.0', dependencies: { 'ffmpeg-static': '1' } })
    mkdirSync(join(root, 'src', 'shared'), { recursive: true })
    writeFileSync(join(root, 'src', 'shared', 'product.json'), JSON.stringify({ name: 'P' }))
    pkg(join(root, 'node_modules', 'ffmpeg-static'), {
      name: 'ffmpeg-static',
      version: '5.0.0',
      license: 'GPL-3.0-or-later'
    })
    pkg(
      join(root, 'node_modules', 'electron'),
      { name: 'electron', version: '39.0.0' },
      {
        LICENSE: 'MIT electron'
      }
    )
    const { problems } = buildNotices(root)
    expect(problems).toEqual(
      expect.arrayContaining([
        'ffmpeg-static の ffmpeg.LICENSE(Windows では ffmpeg.exe.LICENSE)も、scripts/license-texts/GPL-3.0.txt もありません',
        'ffmpeg を実行して版と構成を読めませんでした',
        'Electron の LICENSES.chromium.html がありません'
      ])
    )
    expect(problems.some((p) => p.includes('Electron の LICENSE がありません'))).toBe(false)
  })

  /** ffmpeg-static だけを入れた小さなプロジェクト(実行ファイルは動かない偽物) */
  function ffmpegOnlyProject(name: string, ffmpegFiles: Record<string, string>): string {
    const root = join(tmp, name)
    pkg(root, { name: 'app', version: '1.0.0', dependencies: { 'ffmpeg-static': '1' } })
    mkdirSync(join(root, 'src', 'shared'), { recursive: true })
    writeFileSync(join(root, 'src', 'shared', 'product.json'), JSON.stringify({ name: 'P' }))
    pkg(
      join(root, 'node_modules', 'ffmpeg-static'),
      { name: 'ffmpeg-static', version: '5.3.0', license: 'GPL-3.0-or-later' },
      ffmpegFiles
    )
    return root
  }
  const licenseProblem = (problems: string[]): boolean =>
    problems.some((p) => p.includes('LICENSE') && p.includes('ffmpeg'))

  it('Windows の ffmpeg-static(ffmpeg.exe の横の ffmpeg.exe.LICENSE・ffmpeg.exe.README)も GPL の全文と構成を載せる', () => {
    // ffmpeg-static の install.js は「実行ファイルのパス + .LICENSE」に落とす。Windows では ffmpeg.exe.LICENSE
    const root = ffmpegOnlyProject('win-layout', {
      'ffmpeg.exe': 'not really an exe',
      'ffmpeg.exe.LICENSE': 'WIN GPL3 TEXT',
      'ffmpeg.exe.README': 'FFmpeg 64-bit static Windows build from www.gyan.dev'
    })
    const { problems, text } = buildNotices(root)
    expect(licenseProblem(problems)).toBe(false)
    expect(text).toContain('WIN GPL3 TEXT')
    expect(text).toContain('Windows build from www.gyan.dev')
  })

  it('ffmpeg-static が LICENSE を配らなかったときは、リポジトリに置いた GPL v3 の全文を載せる', () => {
    const root = ffmpegOnlyProject('no-license', { 'ffmpeg.exe': 'not really an exe' })
    mkdirSync(join(root, 'scripts', 'license-texts'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'license-texts', 'GPL-3.0.txt'), 'REPO GPL3 TEXT')
    const { problems, text } = buildNotices(root)
    expect(licenseProblem(problems)).toBe(false)
    expect(text).toContain('REPO GPL3 TEXT')
  })

  it('リポジトリの GPL v3 の全文は FSF の GPL v3 そのもの', () => {
    const gpl = readFileSync(
      join(__dirname, '..', '..', 'scripts', 'license-texts', 'GPL-3.0.txt'),
      'utf-8'
    )
    expect(gpl).toContain('GNU GENERAL PUBLIC LICENSE')
    expect(gpl).toContain('Version 3, 29 June 2007')
    expect(gpl).toContain('END OF TERMS AND CONDITIONS')
  })

  // Windows はシンボリックリンクを作るのに管理者の権限が要る
  it.skipIf(process.platform === 'win32')(
    'シンボリックリンク経由で実行しても、直接の実行と分かって表記を作る',
    () => {
      const link = join(tmp, 'notices-link.mjs')
      symlinkSync(join(__dirname, '..', '..', 'scripts', 'third-party-notices.mjs'), link)
      const out = execFileSync(process.execPath, [link], { encoding: 'utf-8', timeout: 60000 })
      expect(out).toContain('THIRD_PARTY_NOTICES.txt')
      expect(existsSync(join(__dirname, '..', '..', 'resources', 'LICENSES.chromium.html'))).toBe(
        true
      )
    }
  )
})

describe('GPL のソースの入手方法(連絡先があれば書面による申し出も)', () => {
  it('連絡先が無ければ、入手先の URL での提供だけを日本語と英語で書く(書面による申し出は出さない)', () => {
    for (const vendorEmail of ['', undefined, 'TBD', 'noreply@example.invalid']) {
      const text = sourceOfferLines({
        vendor: 'VideoEditor',
        vendorEmail,
        sourceOfferUrl: 'https://github.com/rymaruta/VideoEditor/releases'
      }).join('\n')
      expect(text).toContain('ソースの入手方法(バイナリと同じ場所からの提供)')
      expect(text).toContain(
        '同梱の FFmpeg の対応するソース一式は、https://github.com/rymaruta/VideoEditor/releases の各版のリリースから入手できます(版ごとに置いています)。'
      )
      expect(text).toContain('available at no charge from the same place as this product')
      expect(text).toMatch(/x264/)
      expect(text).not.toContain('書面による申し出')
      expect(text).not.toContain('3 年間')
      expect(text).not.toContain('three years')
      expect(text).not.toContain('@')
    }
  })

  it('連絡先が無く入手先も未定なら「(未定)」と書く', () => {
    const text = sourceOfferLines({ vendor: 'TBD', vendorEmail: '', sourceOfferUrl: 'TBD' }).join(
      '\n'
    )
    expect(text).toContain('入手先: (未定)')
    expect(text).not.toContain('TBD')
  })

  it('連絡先があれば、入手先・連絡先・3 年間(書面による申し出)を日本語と英語で書く', () => {
    const text = sourceOfferLines({
      vendor: '山田映像合同会社',
      vendorEmail: 'support@vendor.co.jp',
      sourceOfferUrl: 'https://vendor.co.jp/oss/'
    }).join('\n')
    expect(text).toContain('少なくとも 3 年間')
    expect(text).toContain('three years')
    expect(text).toContain('https://vendor.co.jp/oss/')
    expect(text).toContain('support@vendor.co.jp')
    expect(text).toContain('山田映像合同会社 は')
    expect(text).toMatch(/x264/)
  })

  it('未定(TBD・example の宛先)は「(未定)」と書き、仮の宛先を載せない', () => {
    const text = sourceOfferLines({
      vendor: 'TBD',
      vendorEmail: 'noreply@example.invalid',
      sourceOfferUrl: 'TBD'
    }).join('\n')
    expect(text).toContain('(未定)')
    expect(text).toContain('販売者(未定) は')
    expect(text).not.toContain('example.invalid')
    expect(text).not.toContain('TBD')
  })

  it('表記の文書の FFmpeg の欄に申し出が入る(GPL の全文より前)', () => {
    const text = renderNotices({
      productName: 'P',
      productVersion: '1',
      packages: [],
      ffmpeg: {
        ffmpeg: { version: 'ffmpeg version 7', readme: '', license: 'GNU GENERAL PUBLIC LICENSE' }
      },
      electron: { version: '1', license: 'MIT' },
      models: [],
      offer: {
        vendor: 'V',
        vendorEmail: 'v@vendor.co.jp',
        sourceOfferUrl: 'https://vendor.co.jp/src'
      }
    })
    const offerAt = text.indexOf('ソースの提供の申し出(書面による申し出)')
    expect(offerAt).toBeGreaterThan(0)
    expect(offerAt).toBeLessThan(text.indexOf('GNU General Public License version 3 の全文'))
    expect(text).toContain('npm run gpl-sources')
  })

  it('連絡先が無ければ、表記の文書の FFmpeg の欄に URL での提供の文が入る(GPL の全文より前)', () => {
    const text = renderNotices({
      productName: 'P',
      productVersion: '1',
      packages: [],
      ffmpeg: {
        ffmpeg: { version: 'ffmpeg version 7', readme: '', license: 'GNU GENERAL PUBLIC LICENSE' }
      },
      electron: { version: '1', license: 'MIT' },
      models: [],
      offer: {
        vendor: 'VideoEditor',
        vendorEmail: '',
        sourceOfferUrl: 'https://github.com/rymaruta/VideoEditor/releases'
      }
    })
    const at = text.indexOf('ソースの入手方法(バイナリと同じ場所からの提供)')
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(text.indexOf('GNU General Public License version 3 の全文'))
    expect(text).not.toContain('書面による申し出')
  })
})

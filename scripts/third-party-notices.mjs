/* eslint-disable @typescript-eslint/explicit-function-return-type -- 型は third-party-notices.d.mts */
// 製品に同梱するサードパーティの部品のライセンス表記を、1つの文書(resources/THIRD_PARTY_NOTICES.txt)に集める。
// 使い方: node scripts/third-party-notices.mjs   (npm run licenses。インストーラを作る前に必ず走る)
//
// 集めるもの
// - npm の部品: package.json の dependencies(と、その依存をたどったもの)と、devDependencies のうち
//   画面に取り込まれて同梱されるもの(BUNDLED_FROM_DEV)。各パッケージの LICENSE・NOTICE などの全文を載せる
// - FFmpeg / FFprobe(ffmpeg-static・ffprobe-static の中の実行ファイル): GPL であることと、ソースの入手先
// - Electron / Chromium: Electron の MIT と、インストール先に置かれる Chromium の表記の場所
// - AI のモデル(同梱するものと、初回に取得するもの)
// - フォント(@fontsource。npm の部品としても全文を載せる)
//
// 依存は node_modules の package.json をたどって集める(新しい依存を足さない)。
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** devDependencies だが、画面のコードに取り込まれて製品に入るもの */
export const BUNDLED_FROM_DEV = ['react', 'react-dom']

/** Chromium の表記(Electron が配る)。electron-builder が macOS・snap で消すので resources に写す */
export const CHROMIUM_LICENSES = 'LICENSES.chromium.html'

/** ライセンスの全文・告知が入っているファイルの名前 */
const LICENSE_FILE =
  /^(licen[cs]e|copying|notice|third[-_]?party[-_]?notices?|thirdpartynotices)([-_. ].*)?$/i
/** 上の名前でも、ライセンスの文書ではないもの(コード・型など) */
const NOT_A_TEXT = /\.(js|cjs|mjs|ts|map|json|html?|node|exe|dll|so|dylib)$/i

/** コピーレフト(ソースの入手先を示す義務がある)ライセンス */
const COPYLEFT = /\b(A?GPL|LGPL|MPL|EPL|CDDL)/i

/** 同梱するモデルと、初回に取得するモデル */
export const MODELS = [
  {
    name: 'YuNet(顔の検出。face_detection_yunet_2023mar.onnx)',
    bundled: true,
    license: 'MIT',
    source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
    licenseFile: 'resources/models/face_detection_yunet.LICENSE'
  },
  {
    name: 'RNNoise の声用モデル lq(雑音の除去。rnnoise_voice_lq.rnnn)',
    bundled: true,
    license: '著作権の対象外とされている(下記)。使う RNNoise 本体は BSD-3-Clause(FFmpeg の arnndn)',
    source: 'https://github.com/GregorR/rnnoise-models',
    licenseFile: 'resources/models/rnnoise_voice_lq.LICENSE'
  },
  {
    name: 'Whisper large-v3-turbo(文字起こし。onnx-community/whisper-large-v3-turbo_timestamped)',
    bundled: false,
    license: 'MIT(OpenAI)',
    source: 'https://huggingface.co/openai/whisper-large-v3-turbo'
  },
  {
    name: 'Whisper base(短い区間の文字起こし。Xenova/whisper-base)',
    bundled: false,
    license: 'MIT(OpenAI)',
    source: 'https://huggingface.co/openai/whisper-base'
  },
  {
    name: 'AST(笑い・歓声の検出。Xenova/ast-finetuned-audioset-10-10-0.4593)',
    bundled: false,
    license: 'BSD-3-Clause(元のモデル MIT/ast-finetuned-audioset-10-10-0.4593)',
    source: 'https://huggingface.co/MIT/ast-finetuned-audioset-10-10-0.4593'
  },
  {
    name: 'Qwen2.5 1.5B / 7B / 14B Instruct(このPCの AI。GGUF 4bit。GPU の無い PC は 1.5B)',
    bundled: false,
    license: 'Apache-2.0(Qwen)',
    source:
      'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF , https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF , https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF'
  }
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function readText(path) {
  return readFileSync(path, 'utf-8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trimEnd()
}

/** package.json の license 欄(古い書き方 { type } ・ licenses: [] も読む) */
export function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean)
    if (types.length > 0) return types.join(' OR ')
  }
  return '(記載なし)'
}

/** ソースの場所(repository 欄 → homepage 欄) */
export function sourceOf(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const url = repo || pkg.homepage || ''
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
}

/** パッケージ名から、Node と同じ順(近い node_modules から上へ)でその場所を探す */
function findPackageDir(name, fromDir, projectDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (resolve(dir) === resolve(projectDir)) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function licenseFiles(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => LICENSE_FILE.test(n) && !NOT_A_TEXT.test(n))
    .filter((n) => {
      try {
        return statSync(join(dir, n)).isFile()
      } catch {
        return false
      }
    })
    .sort()
    .map((n) => ({ file: n, text: readText(join(dir, n)) }))
}

/**
 * 同梱される npm の部品を集める。`roots` から dependencies / optionalDependencies をたどる
 * (入っていない optional は飛ばす。必要な依存が見つからないものは missing に残す)。
 */
export function collectPackages(projectDir, roots) {
  const byDir = new Map()
  const missing = []
  const queue = roots.map((name) => ({ name, from: projectDir, optional: false, by: '(製品)' }))
  while (queue.length > 0) {
    const { name, from, optional, by } = queue.shift()
    const dir = findPackageDir(name, from, projectDir)
    if (!dir) {
      if (!optional) missing.push(`${name}(${by} が使う)`)
      continue
    }
    const key = realpathSync(dir)
    if (byDir.has(key)) continue
    const pkg = readJson(join(dir, 'package.json'))
    byDir.set(key, {
      name: pkg.name ?? name,
      version: pkg.version ?? '',
      license: licenseOf(pkg),
      source: sourceOf(pkg),
      author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name ?? ''),
      files: licenseFiles(dir)
    })
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      queue.push({ name: dep, from: dir, optional: false, by: pkg.name })
    for (const dep of Object.keys(pkg.optionalDependencies ?? {}))
      queue.push({ name: dep, from: dir, optional: true, by: pkg.name })
  }
  const packages = [...byDir.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)
  )
  return { packages, missing: [...new Set(missing)].sort() }
}

/** 製品に入る npm の部品の出発点(package.json の dependencies と、画面に取り込まれる devDependencies) */
export function productRoots(projectPkg) {
  return [
    ...Object.keys(projectPkg.dependencies ?? {}),
    ...Object.keys(projectPkg.optionalDependencies ?? {}),
    ...BUNDLED_FROM_DEV.filter(
      (n) => projectPkg.devDependencies?.[n] || projectPkg.dependencies?.[n]
    )
  ]
}

/** ffmpeg・ffprobe の版と構成(実行できなければ空) */
function binaryVersion(path) {
  try {
    return execFileSync(path, ['-version'], { encoding: 'utf-8', timeout: 10000 })
      .split('\n')
      .slice(0, 3)
      .join('\n')
      .trim()
  } catch {
    return ''
  }
}

/** 未定の値(scripts/release-check.cjs・src/shared/product.ts と同じ判定) */
function isPlaceholder(value) {
  const v = String(value ?? '').trim()
  return (
    v === '' ||
    /^tbd$/i.test(v) ||
    /(^|[@.])example\.(invalid|com|org|net)$/i.test(v) ||
    /^https?:\/\/([^/]+\.)?example\.(invalid|com|org|net)(\/|$)/i.test(v)
  )
}

/**
 * GPL のソースの提供の申し出(書面による申し出。GPL-3.0 の 6 条 b・GPL-2.0 の 3 条 b)。
 * 入手先・連絡先は product.json(sourceOfferUrl・vendor・vendorEmail)。未定なら「(未定)」と書く
 * (未定のままでは配布用のビルドは scripts/release-check.cjs が止める)。
 */
export function sourceOfferLines(offer) {
  const shown = (v) => (isPlaceholder(v) ? '(未定)' : String(v).trim())
  const vendor = isPlaceholder(offer?.vendor) ? '販売者(未定)' : String(offer?.vendor).trim()
  const email = shown(offer?.vendorEmail)
  const url = shown(offer?.sourceOfferUrl)
  return [
    'ソースの提供の申し出(書面による申し出)',
    '',
    `${vendor} は、本製品に同梱した FFmpeg / FFprobe の実行ファイルについて、それに対応する完全なソース`,
    '(FFmpeg 本体と、ビルドに使われた x264・x265 などのライブラリのソース、ビルドの設定と手順)を、',
    '本製品のその版を最後に配布した日から少なくとも 3 年間、本製品を受け取ったどなたにも提供します。',
    '',
    `  入手先(ダウンロード): ${url}`,
    `  媒体での請求: ${email} 宛に、製品名・版・使っている OS を書いてご連絡ください。`,
    '                媒体と送料の実費のほかに費用はいただきません。',
    '',
    'Written offer for source code',
    '',
    `For at least three years after the last distribution of each version of this product, ${vendor}`,
    'will give anyone who received it the complete corresponding source code of the FFmpeg / FFprobe',
    'executables included with it (FFmpeg itself, the GPL libraries such as x264 and x265 used to build them,',
    'and the build configuration), for no more than the cost of physically performing the distribution.',
    '',
    `  Download: ${url}`,
    `  Request on a medium: write to ${email}`
  ]
}

function rule(title) {
  return `\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`
}

/**
 * 文書を組み立てる。
 * @param {object} input
 * @param {string} input.productName 製品名
 * @param {string} input.productVersion 製品の版
 * @param {{ name: string, version: string, license: string, source: string, author: string, files: { file: string, text: string }[], standardText?: string }[]} input.packages
 * @param {{ ffmpeg?: { version: string, readme: string, license: string }, ffprobe?: { version: string } }} input.ffmpeg
 * @param {{ version: string, license: string }} input.electron
 * @param {{ name: string, bundled: boolean, license: string, source: string, text?: string }[]} input.models
 * @param {{ vendor?: string, vendorEmail?: string, sourceOfferUrl?: string }} [input.offer] ソースの提供の申し出の宛先
 */
export function renderNotices(input) {
  const out = []
  const pkgCount = input.packages.length
  out.push(
    `${input.productName} ${input.productVersion} サードパーティのソフトウェアとライセンス`,
    `Third-party software notices for ${input.productName} ${input.productVersion}`,
    '',
    `${input.productName} は、以下のオープンソースのソフトウェア・フォント・AI のモデルを使っています。`,
    'それぞれの著作権は各作者にあり、各ライセンスの条件で使っています。',
    '',
    '目次',
    '  1. FFmpeg / FFprobe(GPL)',
    '  2. Electron / Chromium',
    '  3. AI のモデル',
    '  4. フォント',
    `  5. npm のパッケージ(${pkgCount} 件)の一覧`,
    '  6. コピーレフトのライセンスの部品と、ソースの入手先',
    '  7. ライセンスの全文'
  )

  // 1. FFmpeg
  out.push(rule('1. FFmpeg / FFprobe'))
  out.push(
    '動画・音声の読み込みと書き出しに FFmpeg と FFprobe の実行ファイルを同梱しています',
    '(npm の ffmpeg-static・ffprobe-static が配る、各 OS 用にビルドされたもの)。',
    '',
    'これらは --enable-gpl --enable-version3 でビルドされており(x264・x265 などの GPL の部品を含む)、',
    '実行ファイル全体が GNU General Public License version 3 以降(GPL-3.0-or-later)の条件で配られます。',
    '本製品は FFmpeg を別のプログラムとして呼び出して使っており、FFmpeg の実行ファイルそのものには手を加えていません。',
    'GPL の条件により、利用者は FFmpeg のソースを入手し、変更し、再配布できます。',
    '',
    'ソースの入手先:',
    '  - FFmpeg 本体: https://ffmpeg.org/download.html#get-sources (版ごと: https://ffmpeg.org/releases/ )',
    '  - 同梱の実行ファイルの出どころ・ビルドの方法:',
    '      ffmpeg-static  https://github.com/eugeneware/ffmpeg-static (配布: https://github.com/eugeneware/ffmpeg-static/releases )',
    '      ffprobe-static https://github.com/joshwnj/ffprobe-static',
    '      Linux 版のビルド: https://johnvansickle.com/ffmpeg/ (ソース一式も同所で配布)',
    '      Windows 版のビルド: https://www.gyan.dev/ffmpeg/builds/',
    '      macOS 版のビルド: https://evermeet.cx/pub/ffmpeg/ (Intel)、https://osxexperts.net/ (Apple Silicon)',
    '',
    '同梱した実行ファイルと同じ版のソース一式は、下の「ソースの提供の申し出」の入手先で配っています',
    '(作り方: npm run gpl-sources。取得元と SHA-256 を MANIFEST.txt に記録)。',
    ''
  )
  if (input.ffmpeg.ffmpeg) {
    out.push('同梱した ffmpeg の版と構成:')
    if (input.ffmpeg.ffmpeg.version) out.push(indent(input.ffmpeg.ffmpeg.version))
    if (input.ffmpeg.ffmpeg.readme) out.push('', indent(input.ffmpeg.ffmpeg.readme))
    out.push('')
  }
  if (input.ffmpeg.ffprobe?.version) {
    out.push('同梱した ffprobe の版と構成:', indent(input.ffmpeg.ffprobe.version), '')
  }
  out.push(...sourceOfferLines(input.offer), '')
  if (input.ffmpeg.ffmpeg?.license) {
    out.push('GNU General Public License version 3 の全文:', '', input.ffmpeg.ffmpeg.license, '')
  }

  // 2. Electron
  out.push(rule('2. Electron / Chromium'))
  out.push(
    `本製品は Electron ${input.electron.version}(MIT License)の上で動きます。Electron は Chromium と Node.js を含みます。`,
    'Chromium とその部品のライセンスの全文(LICENSES.chromium.html)は、どの OS でもアプリの resources の中',
    '(Windows・Linux: インストール先の resources/app.asar.unpacked/resources/ 、',
    ' macOS: アプリの中の Contents/Resources/app.asar.unpacked/resources/)に同梱しており、',
    'ヘルプ > バージョン情報 の「Chromium のライセンス…」からも開けます。',
    'ソース: https://github.com/electron/electron 、https://source.chromium.org/chromium',
    '',
    'Electron の MIT License:',
    '',
    input.electron.license,
    ''
  )

  // 3. モデル
  out.push(rule('3. AI のモデル'))
  out.push(
    '「同梱」は製品に入っているもの、「初回に取得」は機能を初めて使うときに Hugging Face から取得して',
    'このPCに保存するもの(製品には入っていません)。',
    ''
  )
  for (const m of input.models) {
    out.push(
      `- ${m.name}`,
      `    ${m.bundled ? '同梱' : '初回に取得'} / ライセンス: ${m.license}`,
      `    入手先: ${m.source}`
    )
    if (m.text) out.push('', indent(m.text, 4))
    out.push('')
  }

  // 4. フォント
  const fonts = input.packages.filter((p) => p.name.startsWith('@fontsource/'))
  out.push(rule('4. フォント'))
  out.push(
    '画面の文字(Geist)とテロップ用のフォントを同梱しています(npm の @fontsource が配るフォント)。',
    'ライセンスの全文は「7. ライセンスの全文」の各パッケージの欄にあります。',
    ''
  )
  for (const f of fonts) out.push(`- ${f.name} ${f.version}  ${f.license}`)
  out.push('')

  // 5. 一覧
  out.push(rule(`5. npm のパッケージ(${pkgCount} 件)`))
  for (const p of input.packages)
    out.push(`- ${p.name}@${p.version}  ${p.license}${p.source ? `  ${p.source}` : ''}`)
  out.push('')

  // 6. コピーレフト
  const copyleft = input.packages.filter((p) => COPYLEFT.test(p.license))
  out.push(rule('6. コピーレフトのライセンスの部品と、ソースの入手先'))
  out.push(
    'FFmpeg / FFprobe(1. を参照)のほか、次の部品はコピーレフトのライセンスです。改変はしていません。',
    'ソースは各入手先から得られます。',
    ''
  )
  if (copyleft.some((p) => p.name.startsWith('@img/sharp-libvips')))
    out.push(
      'libvips(@img/sharp-libvips-*)は共有ライブラリのまま、アプリのアーカイブの外(app.asar.unpacked)に置いており、差し替えられます。',
      ''
    )
  if (copyleft.length === 0) out.push('(該当なし)')
  for (const p of copyleft)
    out.push(`- ${p.name}@${p.version}  ${p.license}  ソース: ${p.source || '(記載なし)'}`)
  out.push('')

  // 7. 全文
  out.push(rule('7. ライセンスの全文'))
  for (const p of input.packages) {
    out.push(`${'-'.repeat(78)}\n${p.name}@${p.version}  (${p.license})`)
    if (p.author) out.push(`作者: ${p.author}`)
    if (p.source) out.push(`ソース: ${p.source}`)
    out.push('')
    if (p.files.length === 0 && p.standardText)
      out.push(
        `(このパッケージには全文のファイルが含まれていないため、${p.license} の標準の文面に package.json の作者を入れたもの)`,
        '',
        p.standardText,
        ''
      )
    else if (p.files.length === 0)
      out.push(
        `(このパッケージには全文のファイルが含まれていません。ライセンスは ${p.license}。全文はソースの入手先を参照)`,
        ''
      )
    for (const f of p.files) {
      if (p.files.length > 1) out.push(`[${f.file}]`)
      out.push(f.text, '')
    }
  }
  return out.join('\n') + '\n'
}

function indent(text, n = 2) {
  const pad = ' '.repeat(n)
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n')
}

/** 全文のファイルを持たないパッケージに使う、ライセンスの標準の文面(scripts/license-texts) */
const STANDARD_TEXTS = [
  { match: /^MIT$/i, file: 'MIT.txt' },
  { match: /^ISC$/i, file: 'ISC.txt' },
  { match: /^LGPL-3\.0(-or-later|-only|\+)?$/i, file: 'LGPL-3.0.txt' }
]

export function standardLicenseText(license, author, name, textsDir) {
  const hit = STANDARD_TEXTS.find((t) => t.match.test(license.trim()))
  if (!hit) return undefined
  const path = join(textsDir, hit.file)
  if (!existsSync(path)) return undefined
  return readText(path).replaceAll('{{copyright}}', author || `the ${name} authors`)
}

/** プロジェクトから全部を集めて文書にする */
export function buildNotices(projectDir) {
  const projectPkg = readJson(join(projectDir, 'package.json'))
  const product = readJson(join(projectDir, 'src/shared/product.json'))
  const collected = collectPackages(projectDir, productRoots(projectPkg))
  const { missing } = collected
  const textsDir = join(projectDir, 'scripts', 'license-texts')
  const packages = collected.packages.map((p) =>
    p.files.length > 0
      ? p
      : { ...p, standardText: standardLicenseText(p.license, p.author, p.name, textsDir) }
  )

  const ffmpegDir = findPackageDir('ffmpeg-static', projectDir, projectDir)
  const ffprobeDir = findPackageDir('ffprobe-static', projectDir, projectDir)
  const ffmpegExe = ffmpegDir
    ? [join(ffmpegDir, 'ffmpeg'), join(ffmpegDir, 'ffmpeg.exe')].find((p) => existsSync(p))
    : undefined
  const ffprobeExe = ffprobeDir
    ? join(
        ffprobeDir,
        'bin',
        process.platform,
        process.arch,
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
      )
    : undefined
  const optionalText = (path) => (path && existsSync(path) ? readText(path) : '')

  const electronDir = findPackageDir('electron', projectDir, projectDir)
  const electron = {
    version: electronDir ? readJson(join(electronDir, 'package.json')).version : '',
    license: electronDir ? optionalText(join(electronDir, 'LICENSE')) : ''
  }
  const chromiumLicenses = electronDir ? join(electronDir, 'dist', CHROMIUM_LICENSES) : ''
  const ffmpegVersion = ffmpegExe ? binaryVersion(ffmpegExe) : ''
  const ffprobeVersion = ffprobeExe ? binaryVersion(ffprobeExe) : ''
  const ffmpegLicense = ffmpegDir ? optionalText(join(ffmpegDir, 'ffmpeg.LICENSE')) : ''

  // 表記が欠けたまま出荷しないよう、欠けたものを挙げる(CLI は失敗で終わる)
  const problems = []
  if (!ffmpegDir) problems.push('ffmpeg-static が入っていません')
  if (!ffmpegLicense) problems.push('ffmpeg-static の ffmpeg.LICENSE がありません')
  if (!ffmpegVersion) problems.push('ffmpeg を実行して版と構成を読めませんでした')
  if (!ffprobeVersion) problems.push('ffprobe を実行して版と構成を読めませんでした')
  if (!electron.license) problems.push('Electron の LICENSE がありません')
  if (!chromiumLicenses || !existsSync(chromiumLicenses))
    problems.push(`Electron の ${CHROMIUM_LICENSES} がありません`)

  const models = MODELS.map((m) => ({
    ...m,
    text: m.licenseFile ? optionalText(join(projectDir, m.licenseFile)) : undefined
  }))

  const text = renderNotices({
    productName: product.name,
    productVersion: projectPkg.version,
    packages,
    ffmpeg: {
      ffmpeg: ffmpegDir
        ? {
            version: ffmpegVersion,
            readme: optionalText(join(ffmpegDir, 'ffmpeg.README')),
            license: ffmpegLicense
          }
        : undefined,
      ffprobe: ffprobeExe ? { version: ffprobeVersion } : undefined
    },
    electron,
    models,
    offer: {
      vendor: product.vendor,
      vendorEmail: product.vendorEmail,
      sourceOfferUrl: product.sourceOfferUrl
    }
  })
  return { text, packages, missing, problems, chromiumLicenses }
}

/** 実際のパスで比べる(シンボリックリンク・相対パスで呼ばれても、直接実行かどうかを誤らない) */
function isDirectRun() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectRun()) {
  const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const { text, packages, missing, problems, chromiumLicenses } = buildNotices(projectDir)
  if (missing.length > 0) {
    console.error(
      `見つからない依存があります(npm ci をやり直してください):\n  ${missing.join('\n  ')}`
    )
    process.exit(1)
  }
  if (problems.length > 0) {
    console.error(`ライセンス表記が揃わないので作りません:\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }
  // Chromium の表記は electron-builder が macOS・snap で消すので、resources に写して同梱する
  copyFileSync(chromiumLicenses, join(projectDir, 'resources', CHROMIUM_LICENSES))
  const outPath = join(projectDir, 'resources', 'THIRD_PARTY_NOTICES.txt')
  // 先頭の BOM: Windows のメモ帳・ブラウザが UTF-8 と分かるように
  writeFileSync(outPath, '\uFEFF' + text)
  console.log(`${outPath}: ${packages.length} packages, ${(text.length / 1024).toFixed(0)} KB`)
}

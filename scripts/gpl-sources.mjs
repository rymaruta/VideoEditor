/* eslint-disable @typescript-eslint/explicit-function-return-type -- 型は gpl-sources.d.mts */
// 同梱する FFmpeg / FFprobe(GPL)の実行ファイルに対応するソース一式を集めて、1つのアーカイブにする。
// 使い方: npm run gpl-sources [-- オプション]
//
//   --ffmpeg <path>      調べる ffmpeg(既定: node_modules/ffmpeg-static の、この PC 用のもの)
//   --ffprobe <path>     調べる ffprobe(既定: node_modules/ffprobe-static の、この PC 用のもの)
//   --out <dir>          出力先(既定: dist/gpl-sources)
//   --source <id>=<url>  自動で決められなかった部品の入手先を手で与える(何度でも。id は MANIFEST の名前)
//   --allow-missing      決められない部品が残っても作る(MANIFEST に「未取得」と書く。配布には使わない)
//   --dry-run            ダウンロードせず、集める物の一覧だけ出す
//
// **配布する PC と同じ OS で走らせる**(Windows 版のインストーラに入る ffmpeg.exe は、Windows で
// npm install したときに入るもの)。実行ファイルを動かして版・ビルドの設定・x264 の版を読む。
//
// 集める物
// - FFmpeg 本体(ffmpeg.org の、同じ版のリリース。git のビルドならその版の snapshot)
// - ビルドに使われた GPL のライブラリ(x264・x265・xvid・rubberband・frei0r・vid.stab)。版は
//   ffmpeg-static が配る README(ffmpeg.README)と、x264 で 1 コマだけ書いて読む版の印から決める
// - 同梱した実行ファイルの -version の出力・README・LICENSE
// - MANIFEST.txt / manifest.json: 部品ごとの版・ライセンス・取得元・SHA-256。GPL 以外のライブラリ
//   (LGPL・BSD など)も、使われていることと版を記録する
//
// ダウンロードは curl(Windows 10 以降・macOS・Linux に入っている。HTTPS_PROXY に従う)。
// 作り方・置き場は docs/GPL_COMPLIANCE.md。
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** ffmpeg / ffprobe の -version の出力を読む */
export function parseVersionOutput(text) {
  const head = /^(ffmpeg|ffprobe) version (\S+)/m.exec(text ?? '')
  const version = head ? head[2] : ''
  const configuration = (/^configuration:\s*(.*)$/m.exec(text ?? '') ?? [])[1]?.trim() ?? ''
  // 6.1.1-essentials_build-www.gyan.dev・7.0.2-static・n6.1.1 → 6.1.1
  const release = (/^n?(\d+\.\d+(?:\.\d+)?)(?![\d.])/.exec(version) ?? [])[1] ?? null
  // git のビルド: N-113000-gabcdef0・2024-01-01-git-abcdef0-full_build
  const gitHash = release
    ? null
    : ((/(?:^|-)g([0-9a-f]{7,40})(?:-|$)/.exec(version) ??
        /git-([0-9a-f]{7,40})/.exec(version) ??
        [])[1] ?? null)
  const enabled = new Set()
  for (const m of configuration.matchAll(/--enable-([a-z0-9_-]+)/g)) enabled.add(m[1])
  return { version, release, gitHash, configuration, enabled: [...enabled].sort() }
}

/** ffmpeg-static が配る README(「libx264: 0.164.3191」の並び)から、ライブラリの版を読む */
export function parseReadmeVersions(readme) {
  const out = {}
  for (const line of String(readme ?? '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][\w.+-]*)\s*:\s*(\S.*?)\s*$/.exec(line)
    if (!m) continue
    const name = m[1].toLowerCase()
    if (['build', 'version', 'notes', 'email', 'irc', 'url', 'patreon', 'paypal'].includes(name))
      continue
    out[name] = m[2]
  }
  return out
}

/** x264 が書く印(「x264 - core 164 r3191 4613ac3」)を読む */
export function parseX264Banner(text) {
  const m = /x264 - core (\d+) r(\d+) ([0-9a-f]{7,40})/.exec(String(text ?? ''))
  return m ? { core: m[1], revision: m[2], hash: m[3] } : null
}

const isHash = (s) => /^[0-9a-f]{7,40}$/.test(s ?? '')

/**
 * GPL のライブラリ。`flag` は configure の --enable-…、`readme` は README の名前。
 * `resolve` は版の手がかりから { version, url } を返す(決められなければ null)。
 */
export const GPL_LIBRARIES = [
  {
    id: 'x264',
    flag: 'libx264',
    license: 'GPL-2.0-or-later',
    resolve: ({ x264 }) =>
      x264
        ? {
            version: `core ${x264.core} r${x264.revision} ${x264.hash}`,
            url: `https://code.videolan.org/videolan/x264/-/archive/${x264.hash}/x264-${x264.hash}.tar.bz2`
          }
        : null
  },
  {
    id: 'x265',
    flag: 'libx265',
    license: 'GPL-2.0-or-later',
    resolve: ({ readme }) => {
      const v = readme.libx265
      if (!v) return null
      const hash = v.split('-').pop()
      if (v.includes('+') && isHash(hash))
        return {
          version: v,
          url: `https://bitbucket.org/multicoreware/x265_git/get/${hash}.tar.gz`
        }
      if (/^\d+(\.\d+)+$/.test(v))
        return {
          version: v,
          url: `https://bitbucket.org/multicoreware/x265_git/downloads/x265_${v}.tar.gz`
        }
      return null
    }
  },
  {
    id: 'xvid',
    flag: 'libxvid',
    license: 'GPL-2.0-or-later',
    resolve: ({ readme }) =>
      /^\d+(\.\d+)+$/.test(readme.libxvid ?? '')
        ? {
            version: readme.libxvid,
            url: `https://downloads.xvid.com/downloads/xvidcore-${readme.libxvid}.tar.gz`
          }
        : null
  },
  {
    id: 'rubberband',
    flag: 'librubberband',
    license: 'GPL-2.0-or-later',
    resolve: ({ readme }) =>
      /^\d+(\.\d+)+$/.test(readme.librubberband ?? '')
        ? {
            version: readme.librubberband,
            url: `https://breakfastquay.com/files/releases/rubberband-${readme.librubberband}.tar.bz2`
          }
        : null
  },
  {
    id: 'frei0r',
    flag: 'frei0r',
    license: 'GPL-2.0-or-later',
    resolve: ({ readme }) => {
      const v = readme.libfrei0r ?? ''
      // Debian の版(1.6.1-2): Debian のパッケージのソース(元の版 + Debian の変更)を snapshot.debian.org から
      if (/^\d+(?:\.\d+)+-[\w.+~]+$/.test(v))
        return {
          version: v,
          url: `https://snapshot.debian.org/package/frei0r/${v}/`,
          debian: { package: 'frei0r', version: v }
        }
      // 元の版だけ(1.6.1): 作者の配布(タグ)から
      if (/^\d+(?:\.\d+)+$/.test(v))
        return { version: v, url: `https://github.com/dyne/frei0r/archive/refs/tags/v${v}.tar.gz` }
      return null
    }
  },
  {
    id: 'vidstab',
    flag: 'libvidstab',
    license: 'GPL-2.0-or-later',
    // README の版(1.20 など)は vid.stab のタグと対応しない。--source vidstab=<url> で与える
    resolve: () => null
  }
]

/** GPL 以外(LGPL・BSD・MIT など)のライブラリ。版と使われていることだけを記録する */
const OTHER_LIBRARY_NOTE =
  'GPL 以外のライセンス(LGPL・BSD など)。静的にリンクされているので、要求があればこれらのソースも出せるようにしておく(docs/GPL_COMPLIANCE.md)'

/** FFmpeg 本体のソースの場所 */
export function ffmpegSourceUrl(parsed) {
  if (parsed.release) return `https://ffmpeg.org/releases/ffmpeg-${parsed.release}.tar.xz`
  if (parsed.gitHash)
    return `https://git.ffmpeg.org/gitweb/ffmpeg.git/snapshot/${parsed.gitHash}.tar.gz`
  return null
}

/**
 * 1 つの実行ファイルについて、集める物の一覧を作る。
 * @param {{ kind: 'ffmpeg' | 'ffprobe', versionText: string, readme?: string, x264Banner?: string, overrides?: Record<string, string> }} input
 */
export function planSources(input) {
  const parsed = parseVersionOutput(input.versionText)
  const readme = parseReadmeVersions(input.readme)
  const x264 = parseX264Banner(input.x264Banner)
  const overrides = input.overrides ?? {}
  const prefix = input.kind === 'ffmpeg' ? '' : `${input.kind}-`
  const items = []
  const ffmpegId = `${prefix}ffmpeg`
  items.push({
    id: ffmpegId,
    usedBy: input.kind,
    name: 'FFmpeg',
    version: parsed.version || '(不明)',
    license: parsed.enabled.includes('version3') ? 'GPL-3.0-or-later' : 'GPL-2.0-or-later',
    url: overrides[ffmpegId] ?? ffmpegSourceUrl(parsed),
    gpl: true
  })
  for (const lib of GPL_LIBRARIES) {
    if (!parsed.enabled.includes(lib.flag)) continue
    const id = `${prefix}${lib.id}`
    const hit = lib.resolve({ readme, x264 })
    const readmeVersion = readme[lib.flag] ?? readme[`lib${lib.id}`]
    items.push({
      id,
      usedBy: input.kind,
      name: lib.id,
      version: hit?.version ?? readmeVersion ?? '(不明)',
      license: lib.license,
      url: overrides[id] ?? hit?.url ?? null,
      ...(hit?.debian && !overrides[id] ? { debian: hit.debian } : {}),
      gpl: true
    })
  }
  const gplFlags = new Set(GPL_LIBRARIES.map((l) => l.flag))
  const others = parsed.enabled.filter(
    (f) => (f.startsWith('lib') || ['gnutls', 'gmp', 'fontconfig'].includes(f)) && !gplFlags.has(f)
  )
  return {
    kind: input.kind,
    parsed,
    items,
    others: others.map((f) => ({ name: f, version: readme[f] ?? readme[`lib${f}`] ?? '' }))
  }
}

/** 決められなかった GPL の部品 */
export function missingItems(plans) {
  return plans.flatMap((p) => p.items.filter((i) => !i.url))
}

/** MANIFEST.txt を組み立てる */
export function renderManifest({ productName, productVersion, platform, plans, files, createdAt }) {
  const lines = [
    `${productName} ${productVersion} に同梱した FFmpeg / FFprobe の対応するソース`,
    `Corresponding source for the FFmpeg / FFprobe executables shipped with ${productName} ${productVersion}`,
    '',
    `作成: ${createdAt}`,
    `対象: ${platform}`,
    '',
    '同梱した実行ファイルは、FFmpeg とそのライブラリを静的にリンクしたもので、GPL の条件で配られます。',
    'このアーカイブには、その実行ファイルと同じ版の FFmpeg 本体と GPL のライブラリのソースを入れています。',
    '各ファイルの取得元と SHA-256 は下の通りです。ビルドの設定(configure の引数)は *-version.txt にあります。',
    ''
  ]
  for (const plan of plans) {
    lines.push(
      `[${plan.kind}] ${plan.parsed.version}`,
      `  configure: ${plan.parsed.configuration}`,
      ''
    )
    for (const item of plan.items) {
      lines.push(`  - ${item.id}  ${item.version}  (${item.license})`)
      lines.push(
        `      取得元: ${item.url ?? '(未取得: 入手先を決められませんでした。--source で与える)'}`
      )
      for (const f of files.filter((x) => x.id === item.id)) {
        if (f.url !== item.url) lines.push(`      取得元のファイル: ${f.url}`)
        lines.push(
          `      ファイル: sources/${f.file}`,
          `      SHA-256: ${f.sha256}  (${f.size} バイト)`
        )
      }
    }
    if (plan.others.length > 0) {
      lines.push('', `  GPL 以外のライブラリ: ${OTHER_LIBRARY_NOTE}`)
      for (const o of plan.others) lines.push(`    - ${o.name}${o.version ? `  ${o.version}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n') + '\n'
}

function parseArgs(argv) {
  const opts = { overrides: {}, allowMissing: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--ffmpeg') opts.ffmpeg = argv[++i]
    else if (a === '--ffprobe') opts.ffprobe = argv[++i]
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--allow-missing') opts.allowMissing = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--source') {
      const [id, ...rest] = String(argv[++i] ?? '').split('=')
      if (!id || rest.length === 0) throw new Error(`--source は id=url の形で: ${argv[i]}`)
      opts.overrides[id] = rest.join('=')
    } else throw new Error(`知らないオプション: ${a}`)
  }
  return opts
}

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf-8', timeout: 60000, ...options })
}

/** x264 で 1 コマだけ書いて、版の印を読む(書けなければ空) */
function x264Banner(ffmpeg) {
  const r = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x64:d=0.04',
      '-frames:v',
      '1',
      '-c:v',
      'libx264',
      '-f',
      'h264',
      '-'
    ],
    { encoding: 'latin1', timeout: 60000, maxBuffer: 16 * 1024 * 1024 }
  )
  return r.status === 0 ? (r.stdout ?? '') : ''
}

/** 圧縮したアーカイブの頭の印(HTML の案内のページなどを取ってきたら止める) */
export function looksLikeArchive(head) {
  const b = Buffer.from(head)
  if (b.length < 4) return false
  if (b[0] === 0x1f && b[1] === 0x8b) return true // gzip
  if (b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68) return true // bzip2
  if (b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a && b[3] === 0x58) return true // xz
  if (b[0] === 0x50 && b[1] === 0x4b) return true // zip
  if (b.length > 262 && b.subarray(257, 262).toString('latin1') === 'ustar') return true // tar
  return false
}

/** Debian のパッケージのソースのファイル(snapshot.debian.org の一覧から) */
export function debianSourceFiles(json, wanted) {
  const files = []
  for (const [hash, seen] of Object.entries(json?.fileinfo ?? {})) {
    const name = seen?.[0]?.name
    if (!name || name.endsWith('.dsc') || name.endsWith('.asc')) continue
    files.push({ name, sha1: hash, url: `https://snapshot.debian.org/file/${hash}` })
  }
  return files
    .filter((f) => f.name.startsWith(`${wanted.package}_`))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function sha1(path) {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function download(url, dest) {
  // curl は HTTPS_PROXY に従う。失敗(404 など)は終了コードで分かる
  execFileSync('curl', ['-fsSL', '--retry', '3', '--connect-timeout', '30', '-o', dest, url], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 30 * 60 * 1000
  })
}

function fileNameFor(item) {
  const tail = basename(new URL(item.url).pathname)
  return `${item.id}--${tail}`
}

function defaultBinaries(projectDir) {
  const exe = process.platform === 'win32' ? '.exe' : ''
  return {
    ffmpeg: join(projectDir, 'node_modules', 'ffmpeg-static', `ffmpeg${exe}`),
    ffprobe: join(
      projectDir,
      'node_modules',
      'ffprobe-static',
      'bin',
      process.platform,
      process.arch,
      `ffprobe${exe}`
    )
  }
}

export function main(argv, projectDir) {
  const opts = parseArgs(argv)
  const product = JSON.parse(readFileSync(join(projectDir, 'src/shared/product.json'), 'utf-8'))
  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'))
  const bins = { ...defaultBinaries(projectDir) }
  if (opts.ffmpeg) bins.ffmpeg = resolve(opts.ffmpeg)
  if (opts.ffprobe) bins.ffprobe = resolve(opts.ffprobe)
  const platform = `${process.platform}-${process.arch}`

  const plans = []
  const binaryDocs = []
  for (const kind of ['ffmpeg', 'ffprobe']) {
    const path = bins[kind]
    if (!existsSync(path)) throw new Error(`${kind} が見つかりません: ${path}(npm ci をやり直す)`)
    const versionText = run(path, ['-version'])
    const readmePath = kind === 'ffmpeg' ? join(dirname(path), 'ffmpeg.README') : ''
    const licensePath = kind === 'ffmpeg' ? join(dirname(path), 'ffmpeg.LICENSE') : ''
    const readme = readmePath && existsSync(readmePath) ? readFileSync(readmePath, 'utf-8') : ''
    const banner = kind === 'ffmpeg' ? x264Banner(path) : ''
    plans.push(
      planSources({ kind, versionText, readme, x264Banner: banner, overrides: opts.overrides })
    )
    binaryDocs.push({ kind, versionText, readmePath, licensePath })
  }

  const all = plans.flatMap((p) => p.items)
  for (const item of all)
    console.log(
      `${item.url ? '  ' : '! '}${item.id.padEnd(20)} ${item.version}  ${item.url ?? '(入手先を決められません)'}`
    )
  const missing = missingItems(plans)
  if (missing.length > 0 && !opts.allowMissing && !opts.dryRun) {
    throw new Error(
      `入手先を決められない GPL の部品があります: ${missing.map((m) => m.id).join(', ')}\n` +
        '  --source <id>=<url> で入手先を与えるか、確かめるだけなら --allow-missing(docs/GPL_COMPLIANCE.md)'
    )
  }
  if (opts.dryRun) return { plans, archive: null }

  const ffVersion = plans[0].parsed.release ?? plans[0].parsed.version
  const name = `${product.name}-${pkg.version}-ffmpeg-${ffVersion}-${platform}-sources`
  const outDir = resolve(opts.out ?? join(projectDir, 'dist', 'gpl-sources'))
  const stage = join(outDir, name)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(join(stage, 'sources'), { recursive: true })

  const files = []
  const seen = new Map()
  const fetchChecked = (url, dest) => {
    console.log(`取得: ${url}`)
    download(url, dest)
    const head = readFileSync(dest).subarray(0, 512)
    if (!looksLikeArchive(head))
      throw new Error(`アーカイブではない物が返りました(案内のページなど): ${url}`)
  }
  for (const item of all) {
    if (!item.url) continue
    if (item.debian) {
      // Debian のソース: 一覧を取り、元の版(orig)と Debian の変更(debian.tar)を取る。SHA-1 を照らし合わせる
      const listPath = join(stage, 'debian-srcfiles.json')
      download(
        `https://snapshot.debian.org/mr/package/${item.debian.package}/${encodeURIComponent(item.debian.version)}/srcfiles?fileinfo=1`,
        listPath
      )
      const list = debianSourceFiles(JSON.parse(readFileSync(listPath, 'utf-8')), item.debian)
      rmSync(listPath, { force: true })
      if (list.length === 0) throw new Error(`Debian のソースが見つかりません: ${item.url}`)
      for (const f of list) {
        const file = `${item.id}--${f.name}`
        const dest = join(stage, 'sources', file)
        fetchChecked(f.url, dest)
        if (sha1(dest) !== f.sha1) throw new Error(`SHA-1 が合いません: ${f.url}`)
        files.push({
          id: item.id,
          file,
          url: f.url,
          sha256: sha256(dest),
          size: statSync(dest).size
        })
      }
      continue
    }
    // ffmpeg と ffprobe で同じ物(同じ URL)は 1 回だけ
    if (seen.has(item.url)) {
      files.push({ ...seen.get(item.url), id: item.id })
      continue
    }
    const file = fileNameFor(item)
    const dest = join(stage, 'sources', file)
    fetchChecked(item.url, dest)
    const entry = {
      id: item.id,
      file,
      url: item.url,
      sha256: sha256(dest),
      size: statSync(dest).size
    }
    seen.set(item.url, entry)
    files.push(entry)
  }
  for (const d of binaryDocs) {
    writeFileSync(join(stage, `${d.kind}-version.txt`), d.versionText)
    if (d.readmePath && existsSync(d.readmePath))
      copyFileSync(d.readmePath, join(stage, `${d.kind}.README.txt`))
    if (d.licensePath && existsSync(d.licensePath))
      copyFileSync(d.licensePath, join(stage, 'COPYING.GPLv3.txt'))
  }
  const createdAt = new Date().toISOString()
  writeFileSync(
    join(stage, 'MANIFEST.txt'),
    '﻿' +
      renderManifest({
        productName: product.name,
        productVersion: pkg.version,
        platform,
        plans,
        files,
        createdAt
      })
  )
  writeFileSync(
    join(stage, 'manifest.json'),
    JSON.stringify(
      { product: product.name, version: pkg.version, platform, createdAt, plans, files },
      null,
      2
    )
  )
  const archive = join(outDir, `${name}.tar`)
  rmSync(archive, { force: true })
  // tar は Windows 10 以降・macOS・Linux に入っている(ソースは圧縮済みなので、まとめるだけ)
  execFileSync('tar', ['-cf', archive, '-C', outDir, name], { stdio: 'inherit' })
  const digest = sha256(archive)
  writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`)
  rmSync(stage, { recursive: true, force: true })
  console.log(
    `作りました: ${archive}\n  SHA-256: ${digest}\n  ${(statSync(archive).size / 1e6).toFixed(1)} MB`
  )
  if (missing.length > 0)
    console.warn(
      `注意: 入手先を決められなかった部品があります(MANIFEST に「未取得」): ${missing.map((m) => m.id).join(', ')}。このアーカイブは配布に使わない`
    )
  return { plans, archive, missing }
}

function isDirectRun() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectRun()) {
  try {
    main(process.argv.slice(2), resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

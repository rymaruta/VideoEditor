import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path, { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  debianSourceFiles,
  ffmpegSourceUrl,
  ffmpegStaticDocCandidates,
  findFfmpegStaticDocs,
  looksLikeArchive,
  missingItems,
  parseReadmeVersions,
  parseVersionOutput,
  parseX264Banner,
  planSources,
  renderManifest
} from '../../scripts/gpl-sources.mjs'

// ffmpeg-static 5.3.0 の Linux 版(John Van Sickle のビルド)の実際の出力・README の抜き書き
const VERSION_7 = [
  'ffmpeg version 7.0.2-static https://johnvansickle.com/ffmpeg/  Copyright (c) 2000-2024 the FFmpeg developers',
  'built with gcc 8 (Debian 8.3.0-6)',
  'configuration: --enable-gpl --enable-version3 --enable-static --enable-frei0r --enable-gnutls --enable-libaom --enable-librubberband --enable-libvidstab --enable-libx264 --enable-libx265 --enable-libxvid --enable-libopus'
].join('\n')
const README = [
  '                build: ffmpeg-7.0.2-amd64-static.tar.xz',
  '              version: 7.0.2',
  '               libaom: 3.2.0-393-g402e264b94',
  '              libx264: 0.164.3191 ',
  '              libx265: 3.5+1-f0c1022b6',
  '              libxvid: 1.3.7 ',
  '            libfrei0r: 1.6.1-2',
  '           libvidstab: 1.20',
  '              libopus: 1.3.1',
  '        librubberband: 1.8.2',
  '     Notes:  A limitation of statically linking glibc'
].join('\n')
const X264 = 'garbage x264 - core 164 r3191 4613ac3 - H.264/MPEG-4 AVC codec - Copyleft'

describe('GPL のソース一式: 実行ファイルの版の読み取り', () => {
  it('版・リリースの番号・ビルドの設定を読む', () => {
    const p = parseVersionOutput(VERSION_7)
    expect(p.version).toBe('7.0.2-static')
    expect(p.release).toBe('7.0.2')
    expect(p.gitHash).toBeNull()
    expect(p.enabled).toEqual(expect.arrayContaining(['gpl', 'version3', 'libx264', 'frei0r']))
    expect(ffmpegSourceUrl(p)).toBe('https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz')
  })

  it('Windows(gyan.dev)のリリース・git のビルドの版の書き方も読む', () => {
    expect(parseVersionOutput('ffmpeg version 6.1.1-essentials_build-www.gyan.dev').release).toBe(
      '6.1.1'
    )
    expect(parseVersionOutput('ffmpeg version n6.1').release).toBe('6.1')
    const git = parseVersionOutput(
      'ffmpeg version 2024-01-01-git-5e751dabc5-full_build-www.gyan.dev'
    )
    expect(git.release).toBeNull()
    expect(git.gitHash).toBe('5e751dabc5')
    expect(ffmpegSourceUrl(git)).toContain('/snapshot/5e751dabc5.tar.gz')
    expect(parseVersionOutput('ffmpeg version N-113000-g1234567abc').gitHash).toBe('1234567abc')
  })

  it('README のライブラリの版と、x264 の印を読む', () => {
    const r = parseReadmeVersions(README)
    expect(r.libx265).toBe('3.5+1-f0c1022b6')
    expect(r.libxvid).toBe('1.3.7')
    expect(r.build).toBeUndefined()
    expect(parseX264Banner(X264)).toEqual({ core: '164', revision: '3191', hash: '4613ac3' })
    expect(parseX264Banner('nothing')).toBeNull()
  })
})

describe('GPL のソース一式: 集める物の一覧', () => {
  const plan = planSources({
    kind: 'ffmpeg',
    versionText: VERSION_7,
    readme: README,
    x264Banner: X264
  })
  const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]))

  it('FFmpeg 本体と、使われた GPL のライブラリだけを同じ版で挙げる', () => {
    expect(plan.items.map((i) => i.id)).toEqual([
      'ffmpeg',
      'x264',
      'x265',
      'xvid',
      'rubberband',
      'frei0r',
      'vidstab'
    ])
    expect(byId.ffmpeg.license).toBe('GPL-3.0-or-later')
    expect(byId.x264.url).toBe(
      'https://code.videolan.org/videolan/x264/-/archive/4613ac3/x264-4613ac3.tar.bz2'
    )
    expect(byId.x265.url).toBe('https://bitbucket.org/multicoreware/x265_git/get/f0c1022b6.tar.gz')
    expect(byId.xvid.url).toBe('https://downloads.xvid.com/downloads/xvidcore-1.3.7.tar.gz')
    expect(byId.rubberband.url).toContain('rubberband-1.8.2.tar.bz2')
    // Debian のパッケージの版は Debian のソースから
    expect(byId.frei0r.debian).toEqual({ package: 'frei0r', version: '1.6.1-2' })
  })

  it('決められない物は未取得として残し、--source の入手先で埋められる', () => {
    expect(missingItems([plan]).map((i) => i.id)).toEqual(['vidstab'])
    const filled = planSources({
      kind: 'ffmpeg',
      versionText: VERSION_7,
      readme: README,
      x264Banner: X264,
      overrides: { vidstab: 'https://example.org/vid.stab.tar.gz' }
    })
    expect(missingItems([filled])).toEqual([])
  })

  it('x264 の印が無ければ(書けない ffprobe など)x264 は決めない。GPL 以外のライブラリは記録だけ', () => {
    const probe = planSources({
      kind: 'ffprobe',
      versionText: VERSION_7.replace('ffmpeg version', 'ffprobe version')
    })
    expect(probe.items.find((i) => i.id === 'ffprobe-x264')?.url).toBeNull()
    expect(probe.items[0].id).toBe('ffprobe-ffmpeg')
    expect(plan.others.map((o) => o.name)).toEqual(
      expect.arrayContaining(['libaom', 'libopus', 'gnutls'])
    )
    expect(plan.others.map((o) => o.name)).not.toContain('libx264')
  })

  it('MANIFEST に取得元と SHA-256、未取得の物を書く', () => {
    const text = renderManifest({
      productName: 'VideoEditor',
      productVersion: '1.0.0',
      platform: 'win32-x64',
      plans: [plan],
      files: [
        {
          id: 'ffmpeg',
          file: 'ffmpeg--ffmpeg-7.0.2.tar.xz',
          url: byId.ffmpeg.url!,
          sha256: 'ab'.repeat(32),
          size: 10
        }
      ],
      createdAt: '2026-10-23T00:00:00Z'
    })
    expect(text).toContain('VideoEditor 1.0.0')
    expect(text).toContain(`SHA-256: ${'ab'.repeat(32)}`)
    expect(text).toContain('取得元: https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz')
    expect(text).toContain('(未取得')
    expect(text).toContain('--enable-libx264')
  })
})

describe('GPL のソース一式: 取ってきた物の確かめ', () => {
  it('圧縮したアーカイブだけを受け入れ、案内のページ(HTML)は止める', () => {
    expect(looksLikeArchive(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe(true)
    expect(looksLikeArchive(Buffer.from('BZh91AY'))).toBe(true)
    expect(looksLikeArchive(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]))).toBe(true)
    expect(looksLikeArchive(Buffer.from('<!DOCTYPE html><html>'))).toBe(false)
  })

  it('Debian のソースの一覧から、元の版と Debian の変更を選ぶ(.dsc は外す)', () => {
    const files = debianSourceFiles(
      {
        fileinfo: {
          aaa: [{ name: 'frei0r_1.6.1-2.debian.tar.xz' }],
          bbb: [{ name: 'frei0r_1.6.1-2.dsc' }],
          ccc: [{ name: 'frei0r_1.6.1.orig.tar.gz' }]
        }
      },
      { package: 'frei0r', version: '1.6.1-2' }
    )
    expect(files.map((f) => f.name)).toEqual([
      'frei0r_1.6.1-2.debian.tar.xz',
      'frei0r_1.6.1.orig.tar.gz'
    ])
    expect(files[1].url).toBe('https://snapshot.debian.org/file/ccc')
  })
})

// ffmpeg-static 5.3.0(b6.1.1)の Windows 版(gyan.dev のビルド)の README(win32-x64.README)の抜き書き。
// -version の出力は Windows で動かせないので、版の行と configure の GPL の部品だけを写したもの
const VERSION_WIN = [
  'ffmpeg version 6.1.1-essentials_build-www.gyan.dev Copyright (c) 2000-2023 the FFmpeg developers',
  'built with gcc 12.2.0 (Rev10, Built by MSYS2 project)',
  'configuration: --enable-gpl --enable-version3 --enable-static --enable-libx264 --enable-libx265 --enable-libxvid --enable-librubberband --enable-libvidstab --enable-libaom --enable-libopus'
].join('\r\n')
const README_WIN = [
  'FFmpeg 64-bit static Windows build from www.gyan.dev',
  '',
  'Version: 6.1.1-essentials_build-www.gyan.dev',
  '',
  'License: GPL v3',
  '',
  'Source Code: https://github.com/FFmpeg/FFmpeg/commit/e38092ef93',
  '',
  'release-essentials build configuration: ',
  '',
  'ARCH                      x86 (generic)',
  '',
  'Enabled outdevs:',
  'sdl2',
  '',
  "release-essentials external libraries' versions: ",
  '',
  'AMF v1.4.32',
  'aom v3.8.0-180-g0eeb62d344',
  'libass 0.17.0-63-gc047dd2',
  'opus v1.4-9-gc8549975',
  'rubberband v1.8.1',
  'vidstab v1.1.1-4-g05829db',
  'x264 v0.164.3172',
  'x265 3.5-153-gce8642f22',
  'xvid v1.3.7',
  'zimg release-3.0.5-150-g7143181',
  ''
].join('\r\n')

describe('GPL のソース一式: Windows 版(gyan.dev)の ffmpeg-static', () => {
  it('README・LICENSE は「実行ファイル + .README / .LICENSE」(Windows では ffmpeg.exe.LICENSE)を先に探す', () => {
    const win = ffmpegStaticDocCandidates(
      'C:\\app\\node_modules\\ffmpeg-static\\ffmpeg.exe',
      path.win32
    )
    expect(win.license[0]).toBe('C:\\app\\node_modules\\ffmpeg-static\\ffmpeg.exe.LICENSE')
    expect(win.readme[0]).toBe('C:\\app\\node_modules\\ffmpeg-static\\ffmpeg.exe.README')
    expect(win.license).toContain('C:\\app\\node_modules\\ffmpeg-static\\ffmpeg.LICENSE')
    const posix = ffmpegStaticDocCandidates('/app/node_modules/ffmpeg-static/ffmpeg', path.posix)
    expect(posix.license[0]).toBe('/app/node_modules/ffmpeg-static/ffmpeg.LICENSE')
    expect(posix.readme[0]).toBe('/app/node_modules/ffmpeg-static/ffmpeg.README')
  })

  const tmp = mkdtempSync(join(tmpdir(), 've-gplsrc-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('Windows の並び(ffmpeg.exe.LICENSE)を見つけ、LICENSE が無ければリポジトリの GPL v3 の全文を使う', () => {
    const win = join(tmp, 'win')
    mkdirSync(win)
    writeFileSync(join(win, 'ffmpeg.exe'), '')
    writeFileSync(join(win, 'ffmpeg.exe.LICENSE'), 'gpl')
    writeFileSync(join(win, 'ffmpeg.exe.README'), 'readme')
    const fallback = join(tmp, 'GPL-3.0.txt')
    writeFileSync(fallback, 'repo gpl')
    expect(findFfmpegStaticDocs(join(win, 'ffmpeg.exe'), fallback)).toEqual({
      readme: join(win, 'ffmpeg.exe.README'),
      license: join(win, 'ffmpeg.exe.LICENSE'),
      licenseFromPackage: true
    })
    const bare = join(tmp, 'bare')
    mkdirSync(bare)
    writeFileSync(join(bare, 'ffmpeg.exe'), '')
    expect(findFfmpegStaticDocs(join(bare, 'ffmpeg.exe'), fallback)).toEqual({
      readme: null,
      license: fallback,
      licenseFromPackage: false
    })
    expect(findFfmpegStaticDocs(join(bare, 'ffmpeg.exe')).license).toBeNull()
  })

  it('gyan.dev の README のライブラリの版(「x265 3.5-153-gce8642f22」の並び)を読む', () => {
    const r = parseReadmeVersions(README_WIN)
    expect(r.libx265).toBe('3.5-153-gce8642f22')
    expect(r.libxvid).toBe('1.3.7')
    expect(r.librubberband).toBe('1.8.1')
    expect(r.libvidstab).toBe('1.1.1-4-g05829db')
    expect(r.libx264).toBe('0.164.3172')
    expect(r.libaom).toBe('3.8.0-180-g0eeb62d344')
    // 見出し・構成の行は版として拾わない
    expect(r.license).toBeUndefined()
    expect(r.version).toBeUndefined()
    expect(r.libarch).toBeUndefined()
    expect(r.libsdl2).toBeUndefined()
  })

  it('6.1.1 のリリースのソースと、GPL のライブラリをすべて決める(入手先の決まらない部品が残らない)', () => {
    const plan = planSources({
      kind: 'ffmpeg',
      versionText: VERSION_WIN,
      readme: README_WIN,
      x264Banner: 'x264 - core 164 r3172 c1c9931 - H.264/MPEG-4 AVC codec'
    })
    const byId = Object.fromEntries(plan.items.map((i) => [i.id, i]))
    expect(plan.parsed.release).toBe('6.1.1')
    expect(byId.ffmpeg.url).toBe('https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz')
    expect(byId.ffmpeg.license).toBe('GPL-3.0-or-later')
    expect(byId.x264.url).toContain('/x264-c1c9931.tar.bz2')
    expect(byId.x265.url).toBe('https://bitbucket.org/multicoreware/x265_git/get/ce8642f22.tar.gz')
    expect(byId.xvid.url).toBe('https://downloads.xvid.com/downloads/xvidcore-1.3.7.tar.gz')
    expect(byId.rubberband.url).toContain('rubberband-1.8.1.tar.bz2')
    expect(byId.vidstab.url).toBe('https://github.com/georgmartius/vid.stab/archive/05829db.tar.gz')
    expect(missingItems([plan])).toEqual([])
    expect(plan.others.find((o) => o.name === 'libaom')?.version).toBe('3.8.0-180-g0eeb62d344')
  })
})

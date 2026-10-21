import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  exportOutputConflict,
  isSamePath,
  pathKey,
  projectSourcePaths,
  writeExportGuarded
} from '@main/exportOutputGuard'
import type { MediaAsset } from '@shared/types'

/**
 * 【レグレッション】2026-10-21 書き出し先に企画の素材そのものを選ぶと、OS の「上書きしますか」だけで
 * 書き出しが始まり、最後の置き換え(`writeViaPartial` の renameSync)で**素材が書き出した動画に
 * 差し替わっていた**(修正前: 書き出しは成功で終わり、`cam1.mp4` の中身は書き出した動画になった)。
 * いまは main が書き出しを始める前に止め、素材の中身は1バイトも変わらない。
 */

const work = mkdtempSync(join(tmpdir(), 've-exportguard-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const media = join(work, 'media')
mkdirSync(media, { recursive: true })
const cam1 = join(media, 'cam1.mp4')
const original = Buffer.from('ORIGINAL-CAMERA-FOOTAGE')
writeFileSync(cam1, original)

const asset = (extra: Partial<MediaAsset>): MediaAsset =>
  ({ id: 'a', fileName: 'cam1.mp4', filePath: cam1, ...extra }) as MediaAsset

describe('writeExportGuarded — 書き出し先が素材と同じなら始める前に止める', () => {
  it('【レグレッション】素材そのものへの書き出しは、何も書かずに日本語の理由で止める', async () => {
    const write = vi.fn(async (partial: string) => {
      writeFileSync(partial, 'RENDERED-VIDEO')
    })
    await expect(
      writeExportGuarded(cam1, projectSourcePaths({ assets: [asset({})] }), write)
    ).rejects.toThrow(
      /素材「cam1\.mp4」と同じファイルです。[\s\S]*別の名前か別の場所を選んでください/
    )
    expect(write).not.toHaveBeenCalled()
    expect(readFileSync(cam1)).toEqual(original)
  })

  it('対照: 重ならない書き出し先には、ふつうに書き出す', async () => {
    const out = join(work, 'out.mp4')
    await writeExportGuarded(out, projectSourcePaths({ assets: [asset({})] }), async (p) => {
      writeFileSync(p, 'RENDERED-VIDEO')
    })
    expect(readFileSync(out, 'utf-8')).toBe('RENDERED-VIDEO')
    expect(readFileSync(cam1)).toEqual(original)
  })

  it('プロキシ・ノイズ除去の元の録音・その前のプロキシ(OBS から取り出した音声も素材)も守る', () => {
    const protectedPaths = projectSourcePaths({
      assets: [
        asset({
          filePath: '/cache/denoised/cam1.wav',
          proxyPath: '/cache/proxy/abc.mp4',
          denoisedFrom: '/media/cam1.wav',
          proxyBeforeDenoise: '/cache/proxy/old.mp4'
        })
      ]
    })
    for (const p of [
      '/cache/denoised/cam1.wav',
      '/cache/proxy/abc.mp4',
      '/media/cam1.wav',
      '/cache/proxy/old.mp4'
    ])
      expect(exportOutputConflict(p, protectedPaths, 'linux')).toMatch(/書き出しを止めました/)
    expect(exportOutputConflict('/media/cam1-edit.mp4', protectedPaths, 'linux')).toBeNull()
  })

  it('綴りが違っても同じファイルなら止める(`..`・Windows の大文字小文字と区切り)', () => {
    const protectedPaths = projectSourcePaths({ assets: [asset({})] })
    expect(exportOutputConflict(join(media, '..', 'media', 'cam1.mp4'), protectedPaths)).not.toBe(
      null
    )
    expect(pathKey('C:/Media/Cam1.MP4', 'win32')).toBe(pathKey('c:\\media\\cam1.mp4', 'win32'))
    // Linux は大文字小文字を区別する(別のファイル)
    expect(pathKey('/media/Cam1.MP4', 'linux')).not.toBe(pathKey('/media/cam1.mp4', 'linux'))
  })

  it('シンボリックリンク・ハードリンク越しの同じファイルも止める', () => {
    const link = join(work, 'link-to-cam1.mp4')
    symlinkSync(cam1, link)
    expect(isSamePath(link, cam1)).toBe(true)
    expect(exportOutputConflict(link, projectSourcePaths({ assets: [asset({})] }))).toMatch(
      /素材「cam1\.mp4」/
    )
    // 在らないファイル同士は文字列でだけ比べる(0 の i-node を同じとみなさない)
    expect(isSamePath(join(work, 'nope1.mp4'), join(work, 'nope2.mp4'))).toBe(false)
  })

  it('企画ファイル・自動保存への書き出しも止める(.veproj は拡張子だけでも)', () => {
    const veproj = join(work, 'show.veproj')
    expect(exportOutputConflict(veproj, [{ path: veproj, label: '企画ファイル' }])).toMatch(
      /企画ファイルと同じファイルです/
    )
    expect(exportOutputConflict(join(work, 'other.VEPROJ'), [])).toMatch(/企画ファイル\(\.veproj\)/)
    const autosave = join(work, 'autosave.veproj')
    expect(
      exportOutputConflict(autosave, [{ path: autosave, label: '自動保存のファイル' }])
    ).toMatch(/自動保存のファイル/)
  })
})

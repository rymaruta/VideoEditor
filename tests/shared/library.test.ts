import { describe, expect, it } from 'vitest'
import {
  emptyLibrary,
  filterLibraryFiles,
  folderKey,
  forgetFolder,
  guessCategory,
  isWithin,
  libraryFileKind,
  normalizeLibrary,
  parentFolder,
  rememberFolders,
  toggleFavorite,
  type LibraryFile
} from '@shared/library'
import { NASTY_VALUES } from '../helpers/boundary'

const W = 'win32'
const L = 'linux'

describe('library — 一度読み込んだフォルダを覚える', () => {
  it('読み込んだファイルのフォルダを覚える(同じフォルダは1つにまとめる)', () => {
    const s = rememberFolders(
      emptyLibrary(),
      ['D:\\素材\\SE\\ドン.wav', 'D:\\素材\\SE\\ポン.wav'],
      100,
      W
    )
    expect(s.folders).toEqual([{ path: 'D:\\素材\\SE', addedAt: 100, lastUsedAt: 100 }])
  })

  it('覚えているフォルダの下の階層を読み込んでも、新しくは足さず「最後に使った」だけ更新する', () => {
    let s = rememberFolders(emptyLibrary(), ['D:\\素材\\SE\\a.wav'], 100, W)
    s = rememberFolders(s, ['D:\\素材\\SE\\強調\\b.wav'], 200, W)
    expect(s.folders).toEqual([{ path: 'D:\\素材\\SE', addedAt: 100, lastUsedAt: 200 }])
  })

  it('覚えているフォルダの親を読み込んだら、親へ置き換える(同じファイルが二重に並ばない)', () => {
    let s = rememberFolders(emptyLibrary(), ['D:\\素材\\SE\\a.wav', 'D:\\素材\\BGM\\b.mp3'], 100, W)
    s = rememberFolders(s, ['D:\\素材\\c.wav'], 300, W)
    expect(s.folders).toEqual([{ path: 'D:\\素材', addedAt: 100, lastUsedAt: 300 }])
  })

  it('Windows は大文字小文字・区切りの違いを同じフォルダとみなす。Linux は区別する', () => {
    let s = rememberFolders(emptyLibrary(), ['D:\\Sozai\\SE\\a.wav'], 100, W)
    s = rememberFolders(s, ['d:/sozai/se/b.wav'], 200, W)
    expect(s.folders).toHaveLength(1)
    let l = rememberFolders(emptyLibrary(), ['/m/SE/a.wav'], 100, L)
    l = rememberFolders(l, ['/m/se/b.wav'], 200, L)
    expect(l.folders).toHaveLength(2)
  })

  it('最後に使った順に並ぶ', () => {
    let s = rememberFolders(emptyLibrary(), ['/a/x.wav'], 100, L)
    s = rememberFolders(s, ['/b/x.wav'], 200, L)
    s = rememberFolders(s, ['/a/y.wav'], 300, L)
    expect(s.folders.map((f) => f.path)).toEqual(['/a', '/b'])
  })

  it('外す・お気に入りの切り替え', () => {
    let s = rememberFolders(emptyLibrary(), ['/a/x.wav', '/b/y.wav'], 100, L)
    s = forgetFolder(s, '/a/', L)
    expect(s.folders.map((f) => f.path)).toEqual(['/b'])
    s = toggleFavorite(s, 'C:\\SE\\ドン.wav', W)
    expect(s.favorites).toEqual(['C:\\SE\\ドン.wav'])
    s = toggleFavorite(s, 'c:/se/ドン.wav', W)
    expect(s.favorites).toEqual([])
  })

  it('パスの小物: 親フォルダ・内側か・比べる形', () => {
    expect(parentFolder('C:\\a.wav')).toBe('C:\\')
    expect(parentFolder('/m/se/a.wav')).toBe('/m/se')
    expect(isWithin('/m/se/x', '/m/se', L)).toBe(true)
    expect(isWithin('/m/sex', '/m/se', L)).toBe(false)
    expect(folderKey('D:\\A\\B\\', W)).toBe('d:/a/b')
    expect(folderKey('C:\\', W)).toBe('c:/')
  })

  it('壊れた保存内容を読んでも落ちず、正しい形にする', () => {
    for (const v of NASTY_VALUES) expect(normalizeLibrary(v)).toEqual(emptyLibrary())
    expect(
      normalizeLibrary({
        folders: [{ path: '/a', addedAt: 'x', lastUsedAt: 5 }, null, { path: '' }],
        favorites: ['/f', 3]
      })
    ).toEqual({
      version: 1,
      folders: [{ path: '/a', addedAt: 0, lastUsedAt: 5 }],
      favorites: ['/f']
    })
    expect(rememberFolders(emptyLibrary(), ['', 3 as unknown as string], 1, L).folders).toEqual([])
  })

  it('種類と置き場の見当', () => {
    expect(libraryFileKind('a.WAV')).toBe('audio')
    expect(libraryFileKind('a.mov')).toBe('video')
    expect(libraryFileKind('a.txt')).toBeNull()
    expect(guessCategory('D:\\番組素材\\SE')).toBe('se')
    expect(guessCategory('D:\\番組素材\\効果音')).toBe('se')
    expect(guessCategory('D:\\番組素材\\BGM')).toBe('bgm')
    expect(guessCategory('D:\\CG系(20260515更新)')).toBe('cg')
    expect(guessCategory('E:\\収録\\#297')).toBe('footage')
    expect(guessCategory('D:\\Documents')).toBe('other')
  })

  it('検索は空白区切りの語を全部含むものだけ、名前と置き場の両方を見る', () => {
    const f = (
      name: string,
      subfolder: string,
      kind: 'audio' | 'video' = 'audio'
    ): LibraryFile => ({
      path: `/x/${name}`,
      name,
      kind,
      subfolder,
      size: 1,
      modifiedAt: 0
    })
    const files = [
      f('ドン.wav', '強調'),
      f('ドン.wav', 'リアクション'),
      f('opening.mov', '', 'video')
    ]
    expect(filterLibraryFiles(files, 'ドン 強調', 'all')).toHaveLength(1)
    expect(filterLibraryFiles(files, '', 'video').map((x) => x.name)).toEqual(['opening.mov'])
    expect(filterLibraryFiles(files, '  ', 'all')).toHaveLength(3)
  })
})

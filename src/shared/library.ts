import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, fileExtension } from './mediaExtensions'

/**
 * 共通ライブラリ: **一度読み込んだフォルダを覚えて、次の回からも選ぶだけで使えるようにする。**
 *
 * 効果音・BGM・CG版面・収録素材を、プロジェクトのたびに読み込み直さなくて済むように、
 * どのプロジェクトからでも見える「前に読み込んだフォルダ」の一覧を持つ。
 * 登録の操作は要らない: 素材を読み込んだ時点で、そのファイルのあるフォルダを覚える。
 *
 * ここは保存・読み込み・覚え方の規則だけを持つ純関数。フォルダの中身を読む・見張るのは
 * main プロセス(`libraryService`)。
 */

export interface LibraryFolder {
  path: string
  addedAt: number
  lastUsedAt: number
}

export interface LibraryState {
  version: 1
  folders: LibraryFolder[]
  /** ★を付けたファイルのパス */
  favorites: string[]
}

export type LibraryFileKind = 'video' | 'audio'

export interface LibraryFile {
  path: string
  name: string
  kind: LibraryFileKind
  /** 覚えているフォルダからの相対の置き場(表示用。直下なら空) */
  subfolder: string
  size: number
  modifiedAt: number
}

/** 何を入れておく場所か。フォルダ名から見当を付ける(絞り込みの既定に使う) */
export type LibraryCategory = 'se' | 'bgm' | 'cg' | 'footage' | 'other'

export function emptyLibrary(): LibraryState {
  return { version: 1, folders: [], favorites: [] }
}

/** 比べるための形。区切りを `/` に揃え、末尾の区切りを外し、Windows は大文字小文字を区別しない */
export function folderKey(path: string, platform: string): string {
  let p = path.replace(/\\/g, '/')
  while (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1)
  return platform === 'win32' ? p.toLowerCase() : p
}

/** ファイルのパス → それが入っているフォルダ(区切りは元のまま) */
export function parentFolder(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (i <= 0) return filePath.slice(0, i + 1) || filePath
  // `C:\a.wav` の親は `C:\`(ドライブ直下)
  if (i === 2 && /^[A-Za-z]:/.test(filePath)) return filePath.slice(0, 3)
  return filePath.slice(0, i)
}

/** `child` が `ancestor` の中(同じも含む)にあるか */
export function isWithin(child: string, ancestor: string, platform: string): boolean {
  const c = folderKey(child, platform)
  const a = folderKey(ancestor, platform)
  if (c === a) return true
  return c.startsWith(a.endsWith('/') ? a : `${a}/`)
}

/**
 * 読み込んだファイルのフォルダを覚える。
 * - すでに覚えているフォルダの中なら、新しく足さずに「最後に使った日時」だけ更新する
 *   (中身は下の階層まで読むので、子フォルダを別に覚える必要は無い)
 * - 覚えているフォルダの**親**を読み込んだら、親に置き換える(同じファイルが二重に並ばない)
 */
export function rememberFolders(
  state: LibraryState,
  filePaths: readonly string[],
  now: number,
  platform: string
): LibraryState {
  let folders = [...state.folders]
  const dirs: string[] = []
  for (const f of filePaths) {
    if (typeof f !== 'string' || f.length === 0) continue
    const dir = parentFolder(f)
    if (!dirs.some((d) => folderKey(d, platform) === folderKey(dir, platform))) dirs.push(dir)
  }
  for (const dir of dirs) {
    const container = folders.find((x) => isWithin(dir, x.path, platform))
    if (container) {
      folders = folders.map((x) => (x === container ? { ...x, lastUsedAt: now } : x))
      continue
    }
    const children = folders.filter((x) => isWithin(x.path, dir, platform))
    const addedAt = children.length > 0 ? Math.min(...children.map((c) => c.addedAt)) : now
    folders = folders.filter((x) => !children.includes(x))
    folders.push({ path: dir, addedAt, lastUsedAt: now })
  }
  return { ...state, folders: sortFolders(folders) }
}

export function forgetFolder(state: LibraryState, path: string, platform: string): LibraryState {
  const key = folderKey(path, platform)
  return { ...state, folders: state.folders.filter((f) => folderKey(f.path, platform) !== key) }
}

export function toggleFavorite(
  state: LibraryState,
  filePath: string,
  platform: string
): LibraryState {
  const key = folderKey(filePath, platform)
  const has = state.favorites.some((f) => folderKey(f, platform) === key)
  return {
    ...state,
    favorites: has
      ? state.favorites.filter((f) => folderKey(f, platform) !== key)
      : [...state.favorites, filePath]
  }
}

/** 最後に使った順(新しい順) */
export function sortFolders(folders: readonly LibraryFolder[]): LibraryFolder[] {
  return [...folders].sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.path.localeCompare(b.path))
}

/** 外から読んだ JSON を、必ず正しい形に直す(壊れた要素は捨てる) */
export function normalizeLibrary(raw: unknown): LibraryState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyLibrary()
  const r = raw as Record<string, unknown>
  const folders: LibraryFolder[] = []
  if (Array.isArray(r.folders)) {
    for (const f of r.folders) {
      if (typeof f !== 'object' || f === null) continue
      const o = f as Record<string, unknown>
      if (typeof o.path !== 'string' || o.path.length === 0) continue
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      folders.push({ path: o.path, addedAt: num(o.addedAt), lastUsedAt: num(o.lastUsedAt) })
    }
  }
  const favorites = Array.isArray(r.favorites)
    ? r.favorites.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : []
  return { version: 1, folders: sortFolders(folders), favorites }
}

export function libraryFileKind(filePath: string): LibraryFileKind | null {
  const ext = fileExtension(filePath)
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return 'video'
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(ext)) return 'audio'
  return null
}

/** フォルダ名から、何の置き場かの見当を付ける */
export function guessCategory(folderPath: string): LibraryCategory {
  const p = folderPath.toLowerCase()
  if (/(^|[\\/_\- ])(se|sfx)([\\/_\- ]|$)|効果音/.test(p)) return 'se'
  if (/bgm|音楽|music/.test(p)) return 'bgm'
  if (/(^|[\\/_\- ])cg|版面|テロップ素材|graphics/.test(p)) return 'cg'
  if (/収録|撮影|cam|camera|カメラ|footage|dcim/.test(p)) return 'footage'
  return 'other'
}

/** 検索語(空白区切りの全部を含む)で絞る。名前と置き場の両方を見る */
export function filterLibraryFiles(
  files: readonly LibraryFile[],
  query: string,
  kind: LibraryFileKind | 'all'
): LibraryFile[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
  return files.filter((f) => {
    if (kind !== 'all' && f.kind !== kind) return false
    const hay = `${f.name} ${f.subfolder}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

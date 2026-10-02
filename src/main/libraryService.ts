import { app, BrowserWindow } from 'electron'
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'fs'
import { readdir, stat } from 'fs/promises'
import { join, relative } from 'path'
import {
  emptyLibrary,
  forgetFolder,
  libraryFileKind,
  normalizeLibrary,
  rememberFolders,
  toggleFavorite,
  type LibraryFile,
  type LibraryState
} from '@shared/library'
import { IPC } from '@shared/ipc'

/**
 * 共通ライブラリの保存と、覚えたフォルダの中身の読み取り・見張り。
 * 規則(どのフォルダを覚えるか)は `@shared/library`。ここは置き場とファイルの扱いだけ。
 *
 * 保存先は userData の `library.json`。アプリを入れ直しても残る(BGM・ナレーション・
 * 音声認識のモデルと同じ置き場の考え方)。
 */

/** 1フォルダから拾うファイルの上限。ドライブ直下などを覚えても固まらないように */
const MAX_FILES_PER_FOLDER = 20000
/** 潜る深さの上限 */
const MAX_DEPTH = 8

let cache: LibraryState | null = null

function libraryPath(): string {
  return join(app.getPath('userData'), 'library.json')
}

export function loadLibrary(): LibraryState {
  if (cache) return cache
  try {
    cache = existsSync(libraryPath())
      ? normalizeLibrary(JSON.parse(readFileSync(libraryPath(), 'utf-8')))
      : emptyLibrary()
  } catch {
    // 壊れていても起動は止めない(覚えていたフォルダは失うが、素材そのものは消えない)
    cache = emptyLibrary()
  }
  return cache
}

function saveLibrary(next: LibraryState): LibraryState {
  cache = next
  const tmp = join(app.getPath('userData'), `.library-${process.pid}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
    renameSync(tmp, libraryPath())
  } catch {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 後始末の失敗は無視する */
    }
  }
  syncWatchers(next)
  notifyChanged()
  return next
}

export function rememberImportedFiles(filePaths: readonly string[]): LibraryState {
  return saveLibrary(rememberFolders(loadLibrary(), filePaths, Date.now(), process.platform))
}

/** フォルダそのものを覚える(「フォルダを追加…」から)。中の1ファイルを読み込んだのと同じ扱い */
export function rememberFolder(folderPath: string): LibraryState {
  return rememberImportedFiles([join(folderPath, '__folder__')])
}

export function forgetLibraryFolder(folderPath: string): LibraryState {
  return saveLibrary(forgetFolder(loadLibrary(), folderPath, process.platform))
}

export function toggleLibraryFavorite(filePath: string): LibraryState {
  return saveLibrary(toggleFavorite(loadLibrary(), filePath, process.platform))
}

/** 覚えているフォルダの一覧と、それぞれが今もあるか */
export function libraryOverview(): { state: LibraryState; missing: string[] } {
  const state = loadLibrary()
  return { state, missing: state.folders.filter((f) => !existsSync(f.path)).map((f) => f.path) }
}

/** フォルダの中の動画・音声を、下の階層まで拾う */
export async function listLibraryFiles(folderPath: string): Promise<LibraryFile[]> {
  const out: LibraryFile[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_FILES_PER_FOLDER || depth > MAX_DEPTH) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 読めないフォルダ(権限・切断したドライブ)は飛ばす
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES_PER_FOLDER) return
      if (
        e.name.startsWith('.') ||
        e.name === '$RECYCLE.BIN' ||
        e.name === 'System Volume Information'
      )
        continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      const kind = libraryFileKind(e.name)
      if (!kind) continue
      let size = 0
      let modifiedAt = 0
      try {
        const s = await stat(full)
        size = s.size
        modifiedAt = s.mtimeMs
      } catch {
        continue
      }
      const sub = relative(folderPath, dir)
      out.push({
        path: full,
        name: e.name,
        kind,
        subfolder: sub === '' ? '' : sub,
        size,
        modifiedAt
      })
    }
  }
  await walk(folderPath, 0)
  out.sort((a, b) => a.subfolder.localeCompare(b.subfolder) || a.name.localeCompare(b.name))
  return out
}

// ------------------------------------------------------------------ 見張り

const watchers = new Map<string, FSWatcher>()
let notifyTimer: NodeJS.Timeout | null = null

/** 中身が変わったことを画面へ知らせる(連続した変更は 0.5 秒まとめる) */
function notifyChanged(): void {
  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.libraryChanged)
    }
  }, 500)
}

/** 覚えているフォルダだけを見張る。外したフォルダの見張りは止める */
function syncWatchers(state: LibraryState): void {
  const wanted = new Set(state.folders.map((f) => f.path))
  for (const [path, w] of watchers) {
    if (!wanted.has(path)) {
      w.close()
      watchers.delete(path)
    }
  }
  for (const path of wanted) {
    if (watchers.has(path) || !existsSync(path)) continue
    try {
      const w = watch(path, { recursive: true }, () => notifyChanged())
      w.on('error', () => {
        w.close()
        watchers.delete(path)
      })
      watchers.set(path, w)
    } catch {
      // 見張れない環境(ネットワークドライブなど)は、開き直したときに読み直すだけにする
    }
  }
}

export function startLibraryWatchers(): void {
  syncWatchers(loadLibrary())
}

export function stopLibraryWatchers(): void {
  for (const w of watchers.values()) w.close()
  watchers.clear()
}

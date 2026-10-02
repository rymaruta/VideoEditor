import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  filterLibraryFiles,
  folderKey,
  type LibraryFile,
  type LibraryFileKind,
  type LibraryState
} from '@shared/library'
import { toFileUrl } from '../lib/previewSource'
import { formatIpcError } from '../lib/ipcError'
import { PauseIcon, PlayIcon, StarIcon } from './icons'

/**
 * 共通ライブラリ(全プロジェクト共通)。**一度読み込んだフォルダを覚えていて、
 * 次の回からはここから選ぶだけで使える。** 効果音・BGM・CG版面・収録素材を
 * プロジェクトのたびに読み込み直さなくて済むようにする。
 *
 * - 素材を読み込むと、そのフォルダが自動でここに加わる(登録の操作は要らない)
 * - 覚えたフォルダは見張っていて、ファイルを足すと自動で一覧に入る
 * - ダブルクリック(または「追加」)でプロジェクトへ取り込む
 */

const ALL = '__all__'
const FAVORITES = '__favorites__'
/** 一度に並べる件数(効果音フォルダは千件を超えることがあるので、続きは押して出す) */
const PAGE = 300

const platform = navigator.userAgent.includes('Windows') ? 'win32' : 'other'

function folderLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('\\') || path
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

export function LibraryPanel({
  onUse,
  busy,
  usedPaths
}: {
  /** プロジェクトへ取り込む(取り込み済みのものは呼び出し側で除く) */
  onUse: (paths: string[]) => Promise<void>
  busy: boolean
  /** すでにプロジェクトにある素材のパス(印を付ける) */
  usedPaths: ReadonlySet<string>
}): React.JSX.Element {
  const [library, setLibrary] = useState<LibraryState | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [selected, setSelected] = useState<string>(ALL)
  const [files, setFiles] = useState<LibraryFile[]>([])
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<LibraryFileKind | 'all'>('all')
  const [limit, setLimit] = useState(PAGE)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  /** 覚えているフォルダの一覧を読み直す */
  const refreshOverview = useCallback(
    (): Promise<void> =>
      window.api.libraryOverview().then(
        (o) => {
          setLibrary(o.state)
          setMissing(o.missing)
        },
        (e) => setError(formatIpcError(e))
      ),
    []
  )

  useEffect(() => {
    void refreshOverview()
    // フォルダにファイルが足された・消えた・別の画面で覚えた、のどれでも読み直す
    return window.api.onLibraryChanged(() => void refreshOverview())
  }, [refreshOverview])

  // 選んだフォルダの中身(すべて/お気に入りは全フォルダを読んでから絞る)。
  // どの組み合わせを読み終えたかを持ち、読み込み中の表示はそこから出す
  const [loadedFor, setLoadedFor] = useState<{ library: LibraryState; selected: string } | null>(
    null
  )
  useEffect(() => {
    if (!library) return
    let alive = true
    const folders =
      selected === ALL || selected === FAVORITES ? library.folders.map((f) => f.path) : [selected]
    Promise.all(folders.map((f) => window.api.libraryFiles(f))).then(
      (lists) => {
        if (!alive) return
        let all = lists.flat()
        if (selected === FAVORITES) {
          const fav = new Set(library.favorites.map((f) => folderKey(f, platform)))
          all = all.filter((f) => fav.has(folderKey(f.path, platform)))
        }
        setFiles(all)
        setLoadedFor({ library, selected })
      },
      (e) => {
        if (alive) setError(formatIpcError(e))
      }
    )
    return () => {
      alive = false
    }
  }, [library, selected])
  const loading =
    library !== null && (loadedFor?.library !== library || loadedFor?.selected !== selected)

  const favoriteKeys = useMemo(
    () => new Set((library?.favorites ?? []).map((f) => folderKey(f, platform))),
    [library]
  )
  const usedKeys = useMemo(
    () => new Set([...usedPaths].map((p) => folderKey(p, platform))),
    [usedPaths]
  )
  const shown = useMemo(() => filterLibraryFiles(files, query, kind), [files, query, kind])

  async function handleAddFolder(): Promise<void> {
    setError(null)
    try {
      const next = await window.api.libraryAddFolder()
      if (next) await refreshOverview()
    } catch (e) {
      setError(formatIpcError(e))
    }
  }

  async function handleForget(path: string): Promise<void> {
    setError(null)
    try {
      setLibrary(await window.api.libraryForget(path))
      if (selected === path) setSelected(ALL)
    } catch (e) {
      setError(formatIpcError(e))
    }
  }

  async function handleFavorite(path: string): Promise<void> {
    try {
      setLibrary(await window.api.libraryToggleFavorite(path))
    } catch (e) {
      setError(formatIpcError(e))
    }
  }

  function handlePreview(file: LibraryFile): void {
    const el = audioRef.current
    if (!el) return
    if (playing === file.path) {
      el.pause()
      setPlaying(null)
      return
    }
    el.src = toFileUrl(file.path)
    void el.play().catch(() => setPlaying(null))
    setPlaying(file.path)
  }

  async function handleUse(file: LibraryFile): Promise<void> {
    if (usedKeys.has(folderKey(file.path, platform))) return
    await onUse([file.path])
  }

  const folders = library?.folders ?? []
  const missingKeys = new Set(missing.map((m) => folderKey(m, platform)))

  return (
    <div className="library-panel">
      <audio ref={audioRef} onEnded={() => setPlaying(null)} hidden />
      <div className="library-toolbar">
        <select
          aria-label="フォルダ"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value)
            setLimit(PAGE)
          }}
        >
          <option value={ALL}>すべてのフォルダ</option>
          <option value={FAVORITES}>お気に入り</option>
          {folders.map((f) => (
            <option key={f.path} value={f.path}>
              {missingKeys.has(folderKey(f.path, platform)) ? '(見つかりません) ' : ''}
              {folderLabel(f.path)}
            </option>
          ))}
        </select>
        <button
          className="small-button"
          onClick={handleAddFolder}
          title="フォルダを丸ごとライブラリに加えます"
        >
          フォルダを追加…
        </button>
      </div>
      {selected !== ALL && selected !== FAVORITES && (
        <div className="library-folder-path">
          <span title={selected}>{selected}</span>
          <button className="small-button" onClick={() => handleForget(selected)}>
            一覧から外す
          </button>
        </div>
      )}
      <input
        type="search"
        className="library-search"
        placeholder="名前で検索(例: ドン 強調)"
        aria-label="ライブラリを検索"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setLimit(PAGE)
        }}
      />
      <div className="library-filters" role="group" aria-label="種類で絞り込む">
        {(
          [
            ['all', 'すべて'],
            ['audio', '音声'],
            ['video', '動画']
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={`library-chip ${kind === value ? 'active' : ''}`}
            onClick={() => setKind(value)}
          >
            {label}
          </button>
        ))}
        <span className="library-count">
          {loading ? '読み込み中…' : `${shown.length.toLocaleString()} 件`}
        </span>
      </div>
      {error && <p className="error-text">{error}</p>}
      {folders.length === 0 ? (
        <div className="empty-state">
          <p className="hint-text">
            まだフォルダがありません。素材を一度読み込むと、そのフォルダがここに加わり、
            次の回からは選ぶだけで使えます。
          </p>
        </div>
      ) : (
        <ul className="library-list">
          {shown.slice(0, limit).map((f) => {
            const used = usedKeys.has(folderKey(f.path, platform))
            const fav = favoriteKeys.has(folderKey(f.path, platform))
            return (
              <li
                key={f.path}
                className={`library-row ${used ? 'used' : ''}`}
                onDoubleClick={() => void handleUse(f)}
                title={f.path}
              >
                <button
                  className={`library-star ${fav ? 'on' : ''}`}
                  aria-label={fav ? 'お気に入りから外す' : 'お気に入りに入れる'}
                  onClick={() => void handleFavorite(f.path)}
                >
                  <StarIcon width={13} height={13} />
                </button>
                {f.kind === 'audio' ? (
                  <button
                    className="library-play"
                    aria-label={playing === f.path ? '試聴を止める' : '試聴'}
                    onClick={() => handlePreview(f)}
                  >
                    {playing === f.path ? (
                      <PauseIcon width={11} height={11} />
                    ) : (
                      <PlayIcon width={11} height={11} />
                    )}
                  </button>
                ) : (
                  <span className="library-kind">動画</span>
                )}
                <span className="library-name">
                  {f.name}
                  {f.subfolder && <span className="library-sub">{f.subfolder}</span>}
                </span>
                <span className="library-size">{formatSize(f.size)}</span>
                <button
                  className="small-button library-use"
                  disabled={busy || used}
                  onClick={() => void handleUse(f)}
                >
                  {used ? '使用中' : '追加'}
                </button>
              </li>
            )
          })}
          {shown.length > limit && (
            <li className="library-more">
              <button className="small-button" onClick={() => setLimit(limit + PAGE)}>
                さらに表示({(shown.length - limit).toLocaleString()} 件)
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

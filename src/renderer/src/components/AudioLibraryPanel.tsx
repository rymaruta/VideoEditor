import { useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { usePresetStore } from '../store/presetStore'
import {
  searchJamendoMusic,
  searchFreesoundEffects,
  MusicTrackInfo,
  SoundEffectInfo
} from '../lib/audioLibrary'
import { formatIpcError } from '../lib/ipcError'
import { usePausePreviewWhenHidden } from '../lib/pausePreviewWhenHidden'
import {
  KeyIcon,
  SearchIcon,
  MusicIcon,
  PlusIcon,
  PlayIcon,
  ExternalLinkIcon,
  StarIcon
} from './icons'

type LibraryKind = 'music' | 'sfx'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function AudioLibraryPanel(): React.JSX.Element {
  const [kind, setKind] = useState<LibraryKind>('music')
  const jamendoClientId = useSettingsStore((s) => s.jamendoClientId)
  const setJamendoClientId = useSettingsStore((s) => s.setJamendoClientId)
  const freesoundApiKey = useSettingsStore((s) => s.freesoundApiKey)
  const setFreesoundApiKey = useSettingsStore((s) => s.setFreesoundApiKey)
  const envKeySources = useSettingsStore((s) => s.envKeySources)

  const [query, setQuery] = useState('')
  const [musicResults, setMusicResults] = useState<MusicTrackInfo[]>([])
  const [sfxResults, setSfxResults] = useState<SoundEffectInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // 試聴を鳴らしたまま別のタブへ移ると、パネルは `display: none` で居たままなので
  // **音だけ鳴り続ける**。見えなくなったら止める(規則は pausePreviewWhenHidden)。
  const panelRef = useRef<HTMLDivElement>(null)
  usePausePreviewWhenHidden(panelRef, audioRef)

  const addAudioClipWithAsset = useProjectStore((s) => s.addAudioClipWithAsset)
  const addSePreset = usePresetStore((s) => s.addSePreset)

  const apiKey = kind === 'music' ? jamendoClientId : freesoundApiKey
  const trackName = kind === 'music' ? 'BGM' : '効果音'

  async function handleSearch(): Promise<void> {
    if (!apiKey) {
      setError(
        kind === 'music'
          ? 'Jamendo の Client ID を入力してください'
          : 'Freesound の API キーを入力してください'
      )
      return
    }
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    try {
      if (kind === 'music') {
        setMusicResults(await searchJamendoMusic(apiKey, query))
      } else {
        setSfxResults(await searchFreesoundEffects(apiKey, query))
      }
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setLoading(false)
    }
  }

  async function handlePreview(id: string, url: string): Promise<void> {
    setBusyId(`preview-${id}`)
    setError(null)
    try {
      const { filePath } = await window.api.downloadAudioAsset(url, `preview-${id}`)
      if (audioRef.current) {
        audioRef.current.src = `file://${filePath}`
        await audioRef.current.play()
      }
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setBusyId(null)
    }
  }

  async function handleAdd(id: string, url: string, name: string): Promise<void> {
    setBusyId(`add-${id}`)
    setError(null)
    try {
      const { filePath, duration } = await window.api.downloadAudioAsset(url, name)
      // Asset + track + clip as one undoable step, so a single undo doesn't leave
      // an empty track and an unused asset behind.
      addAudioClipWithAsset(
        {
          id: uuid(),
          filePath,
          fileName: name,
          duration,
          width: 0,
          height: 0,
          fps: 0,
          hasAudio: true,
          hasVideo: false
        },
        { trackName }
      )
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setBusyId(null)
    }
  }

  async function handleFavorite(id: string, url: string, name: string): Promise<void> {
    setBusyId(`fav-${id}`)
    setError(null)
    try {
      const { filePath } = await window.api.downloadAudioAsset(url, name)
      addSePreset(name, filePath, name)
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="panel audio-library-panel" ref={panelRef}>
      <div className="panel-header">
        <h2>BGM・効果音ライブラリ</h2>
      </div>
      <p className="hint-text">
        公式APIで提供される著作権フリー音源を検索してタイムラインに追加できます(スクレイピングは行いません)。ライセンス表記が必要な場合があるため、追加後は各音源のライセンスをご確認ください。
      </p>
      <div className="audio-library-kind-tabs">
        <button className={kind === 'music' ? 'active' : ''} onClick={() => setKind('music')}>
          <MusicIcon width={13} height={13} />
          BGM (Jamendo)
        </button>
        <button className={kind === 'sfx' ? 'active' : ''} onClick={() => setKind('sfx')}>
          <MusicIcon width={13} height={13} />
          効果音 (Freesound)
        </button>
      </div>
      <div className="youtube-field">
        <label>
          <KeyIcon width={12} height={12} />
          {kind === 'music' ? 'Jamendo Client ID' : 'Freesound API キー'}
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) =>
            kind === 'music'
              ? setJamendoClientId(e.target.value)
              : setFreesoundApiKey(e.target.value)
          }
          placeholder={kind === 'music' ? 'Client ID を入力' : 'API キーを入力'}
        />
        {(kind === 'music' ? envKeySources.jamendoClientId : envKeySources.freesoundApiKey) && (
          <p className="hint-text">.envファイルの設定値を使用中(入力欄で上書きできます)</p>
        )}
      </div>
      <div className="youtube-search-row">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={kind === 'music' ? '曲調・キーワードで検索' : '効果音の種類で検索'}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button className="icon-button" onClick={handleSearch} disabled={loading} title="検索">
          <SearchIcon width={14} height={14} />
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {loading && <p className="hint-text">検索中...</p>}
      <audio ref={audioRef} style={{ display: 'none' }} />
      <div className="audio-library-results">
        {kind === 'music' &&
          musicResults.map((t) => (
            <div key={t.id} className="audio-library-item">
              <div className="audio-library-info">
                <div className="audio-library-title" title={t.title}>
                  {t.title}
                </div>
                <div className="media-meta">
                  {t.artistName} ・ {formatDuration(t.durationSeconds)}
                </div>
                {t.licenseUrl && (
                  <a
                    className="audio-library-license"
                    href="#"
                    onClick={(e) => {
                      e.preventDefault()
                      window.api.openExternal(t.licenseUrl)
                    }}
                  >
                    <ExternalLinkIcon width={10} height={10} />
                    ライセンス
                  </a>
                )}
              </div>
              <div className="audio-library-actions">
                <button
                  className="icon-button"
                  title="プレビュー再生"
                  disabled={busyId !== null}
                  onClick={() => handlePreview(t.id, t.audioUrl)}
                >
                  <PlayIcon width={13} height={13} />
                </button>
                <button
                  className="icon-button"
                  title="音声トラックに追加"
                  disabled={busyId !== null}
                  onClick={() => handleAdd(t.id, t.audioUrl, `${t.title}.mp3`)}
                >
                  {busyId === `add-${t.id}` ? '...' : <PlusIcon width={13} height={13} />}
                </button>
                <button
                  className="icon-button"
                  title="お気に入りに登録"
                  disabled={busyId !== null}
                  onClick={() => handleFavorite(t.id, t.audioUrl, `${t.title}.mp3`)}
                >
                  {busyId === `fav-${t.id}` ? '...' : <StarIcon width={13} height={13} />}
                </button>
              </div>
            </div>
          ))}
        {kind === 'sfx' &&
          sfxResults.map((s) => (
            <div key={s.id} className="audio-library-item">
              <div className="audio-library-info">
                <div className="audio-library-title" title={s.name}>
                  {s.name}
                </div>
                <div className="media-meta">
                  {s.username} ・ {formatDuration(s.durationSeconds)}
                </div>
                {s.licenseUrl && (
                  <a
                    className="audio-library-license"
                    href="#"
                    onClick={(e) => {
                      e.preventDefault()
                      window.api.openExternal(s.licenseUrl)
                    }}
                  >
                    <ExternalLinkIcon width={10} height={10} />
                    ライセンス
                  </a>
                )}
              </div>
              <div className="audio-library-actions">
                <button
                  className="icon-button"
                  title="プレビュー再生"
                  disabled={busyId !== null}
                  onClick={() => handlePreview(s.id, s.previewUrl)}
                >
                  <PlayIcon width={13} height={13} />
                </button>
                <button
                  className="icon-button"
                  title="音声トラックに追加"
                  disabled={busyId !== null}
                  onClick={() => handleAdd(s.id, s.previewUrl, `${s.name}.mp3`)}
                >
                  {busyId === `add-${s.id}` ? '...' : <PlusIcon width={13} height={13} />}
                </button>
                <button
                  className="icon-button"
                  title="お気に入りに登録"
                  disabled={busyId !== null}
                  onClick={() => handleFavorite(s.id, s.previewUrl, `${s.name}.mp3`)}
                >
                  {busyId === `fav-${s.id}` ? '...' : <StarIcon width={13} height={13} />}
                </button>
              </div>
            </div>
          ))}
        {kind === 'music' && musicResults.length === 0 && !loading && (
          <p className="hint-text">キーワードで検索してください</p>
        )}
        {kind === 'sfx' && sfxResults.length === 0 && !loading && (
          <p className="hint-text">キーワードで検索してください</p>
        )}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { fetchTrendingVideos, searchVideos, YouTubeVideoInfo } from '../lib/youtube'
import { formatIpcError } from '../lib/ipcError'
import { KeyIcon, SearchIcon, SparklesIcon, ExternalLinkIcon } from './icons'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatViews(views: number): string {
  if (views >= 10000) return `${(views / 10000).toFixed(1)}万回`
  return `${views}回`
}

export function YouTubeTrendPanel(): React.JSX.Element {
  const apiKey = useSettingsStore((s) => s.youtubeApiKey)
  const setApiKey = useSettingsStore((s) => s.setYoutubeApiKey)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<YouTubeVideoInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleTrending(): Promise<void> {
    if (!apiKey) {
      setError('YouTube Data API キーを入力してください')
      return
    }
    setLoading(true)
    setError(null)
    try {
      setResults(await fetchTrendingVideos(apiKey))
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleSearch(): Promise<void> {
    if (!apiKey) {
      setError('YouTube Data API キーを入力してください')
      return
    }
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    try {
      setResults(await searchVideos(apiKey, query))
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="panel youtube-panel">
      <div className="panel-header">
        <h2>YouTubeトレンド調査</h2>
      </div>
      <p className="hint-text">
        YouTube公式APIでタイトル・再生時間・再生数などのメタデータのみ表示します(動画のダウンロードは行いません)。
      </p>
      <div className="youtube-field">
        <label>
          <KeyIcon width={12} height={12} />
          YouTube Data API キー
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="APIキーを入力"
        />
      </div>
      <div className="youtube-search-row">
        <button className="primary-button" onClick={handleTrending} disabled={loading}>
          <SparklesIcon width={13} height={13} />
          急上昇(日本)
        </button>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="キーワードで検索"
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button className="icon-button" onClick={handleSearch} disabled={loading} title="検索">
          <SearchIcon width={14} height={14} />
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {loading && <p className="hint-text">読み込み中...</p>}
      <div className="youtube-results">
        {results.map((v) => (
          <div key={v.id} className="youtube-result-item">
            <img src={v.thumbnailUrl} alt={v.title} />
            <div className="youtube-result-info">
              <div className="youtube-result-title" title={v.title}>
                {v.title}
              </div>
              <div className="media-meta">
                {v.channelTitle} ・ {formatDuration(v.durationSeconds)} ・{' '}
                {formatViews(v.viewCount)}
              </div>
              <button
                className="small-button"
                onClick={() => window.api.openExternal(`https://www.youtube.com/watch?v=${v.id}`)}
              >
                <ExternalLinkIcon width={12} height={12} />
                YouTubeで見る
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

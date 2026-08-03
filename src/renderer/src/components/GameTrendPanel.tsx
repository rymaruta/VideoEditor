import { useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { fetchTrendingGamingVideos, YouTubeVideoInfo } from '../lib/youtube'
import { analyzeGamingTrends, GameTrendAnalysis } from '../lib/gameTrendAnalysis'
import { formatIpcError } from '../lib/ipcError'
import { KeyIcon, SparklesIcon, ExternalLinkIcon, TargetIcon } from './icons'

function formatViews(views: number): string {
  if (views >= 10000) return `${(views / 10000).toFixed(1)}万回`
  return `${views}回`
}

export function GameTrendPanel(): React.JSX.Element {
  const youtubeApiKey = useSettingsStore((s) => s.youtubeApiKey)
  const setYoutubeApiKey = useSettingsStore((s) => s.setYoutubeApiKey)
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey)
  const setGeminiApiKey = useSettingsStore((s) => s.setGeminiApiKey)

  const [videos, setVideos] = useState<YouTubeVideoInfo[]>([])
  const [analysis, setAnalysis] = useState<GameTrendAnalysis | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleRefresh(): Promise<void> {
    if (!youtubeApiKey) {
      setError('YouTube Data API キーを入力してください')
      return
    }
    if (!geminiApiKey) {
      setError('Gemini API キーを入力してください')
      return
    }
    setLoading(true)
    setError(null)
    setAnalysis(null)
    try {
      const trending = await fetchTrendingGamingVideos(youtubeApiKey)
      setVideos(trending)
      setAnalysis(await analyzeGamingTrends(geminiApiKey, trending))
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="panel game-trend-panel">
      <div className="panel-header">
        <h2>ゲームトレンド分析</h2>
      </div>
      <p className="hint-text">
        YouTube公式APIで「ゲームカテゴリの急上昇動画(日本)」を取得し、そのタイトルだけを根拠にGemini(AI)がゲーム名とバズっていそうなシーンを要約します。実行するたびに最新の急上昇データを取得します。
      </p>
      <div className="youtube-field">
        <label>
          <KeyIcon width={12} height={12} />
          YouTube Data API キー
        </label>
        <input
          type="password"
          value={youtubeApiKey}
          onChange={(e) => setYoutubeApiKey(e.target.value)}
          placeholder="APIキーを入力"
        />
      </div>
      <div className="youtube-field">
        <label>
          <KeyIcon width={12} height={12} />
          Gemini API キー
        </label>
        <input
          type="password"
          value={geminiApiKey}
          onChange={(e) => setGeminiApiKey(e.target.value)}
          placeholder="APIキーを入力"
        />
      </div>
      <button className="primary-button" onClick={handleRefresh} disabled={loading}>
        <SparklesIcon width={13} height={13} />
        {loading ? '分析中...' : '最新トレンドを分析'}
      </button>
      {error && <p className="error-text">{error}</p>}

      {analysis && analysis.insights.length > 0 && (
        <div className="game-trend-insights">
          <h3>今バズっていそうなゲーム</h3>
          {analysis.insights.map((insight, i) => (
            <div key={i} className="game-trend-insight-card">
              <h4>
                <TargetIcon width={13} height={13} />
                {insight.gameName}
              </h4>
              <p>{insight.sceneSuggestion}</p>
              {insight.evidenceTitles.length > 0 && (
                <ul className="game-trend-evidence">
                  {insight.evidenceTitles.map((t, j) => (
                    <li key={j} title={t}>
                      {t}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {analysis && analysis.generalTips.length > 0 && (
        <div className="game-trend-tips">
          <h3>編集のコツ</h3>
          <ul>
            {analysis.generalTips.map((tip, i) => (
              <li key={i}>{tip}</li>
            ))}
          </ul>
        </div>
      )}

      {videos.length > 0 && (
        <div className="game-trend-source">
          <h3>取得元データ(急上昇ゲーム動画)</h3>
          <div className="youtube-results">
            {videos.map((v) => (
              <div key={v.id} className="youtube-result-item">
                <img src={v.thumbnailUrl} alt={v.title} />
                <div className="youtube-result-info">
                  <div className="youtube-result-title" title={v.title}>
                    {v.title}
                  </div>
                  <div className="media-meta">
                    {v.channelTitle} ・ {formatViews(v.viewCount)}
                  </div>
                  <button
                    className="small-button"
                    onClick={() =>
                      window.api.openExternal(`https://www.youtube.com/watch?v=${v.id}`)
                    }
                  >
                    <ExternalLinkIcon width={12} height={12} />
                    YouTubeで見る
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

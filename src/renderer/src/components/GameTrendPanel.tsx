import { useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { fetchTrendingGamingVideos, YouTubeVideoInfo } from '../lib/youtube'
import {
  analyzeGamingTrends,
  askAboutTrends,
  GameTrendAnalysis,
  TrendChatTurn
} from '../lib/gameTrendAnalysis'
import { compareTrend, saveTrendSnapshot, TrendComparison } from '../lib/trendHistory'
import { formatIpcError } from '../lib/ipcError'
import {
  KeyIcon,
  SparklesIcon,
  ExternalLinkIcon,
  TargetIcon,
  ImageIcon,
  WandIcon,
  MegaphoneIcon
} from './icons'

const SUGGESTED_QUESTIONS = [
  'この中で初心者でも撮りやすいのはどれ？',
  '再生数が伸びているタイトルの共通点は？',
  '明日1本作るなら何をどう撮ればいい？'
]

function formatViews(views: number): string {
  if (views >= 10000) return `${(views / 10000).toFixed(1)}万回`
  return `${views}回`
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  const hours = Math.round(diffMs / (1000 * 60 * 60))
  if (hours < 1) return '1時間以内'
  if (hours < 24) return `${hours}時間前`
  return `${Math.round(hours / 24)}日前`
}

export function GameTrendPanel(): React.JSX.Element {
  const youtubeApiKey = useSettingsStore((s) => s.youtubeApiKey)
  const setYoutubeApiKey = useSettingsStore((s) => s.setYoutubeApiKey)
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey)
  const setGeminiApiKey = useSettingsStore((s) => s.setGeminiApiKey)
  const envKeySources = useSettingsStore((s) => s.envKeySources)

  const [videos, setVideos] = useState<YouTubeVideoInfo[]>([])
  const [analysis, setAnalysis] = useState<GameTrendAnalysis | null>(null)
  const [comparison, setComparison] = useState<TrendComparison | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [chat, setChat] = useState<TrendChatTurn[]>([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)

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
    setComparison(null)
    // The chat is grounded in a specific snapshot of trending videos, so a fresh
    // fetch invalidates it — keeping the old turns would let follow-up questions
    // silently refer to data that is no longer on screen.
    setChat([])
    setChatError(null)
    try {
      const trending = await fetchTrendingGamingVideos(youtubeApiKey)
      setVideos(trending)
      const result = await analyzeGamingTrends(geminiApiKey, trending, instruction)
      setAnalysis(result)
      const gameNames = result.insights.map((i) => i.gameName)
      setComparison(compareTrend(gameNames))
      saveTrendSnapshot(gameNames)
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleAsk(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || asking) return
    if (!geminiApiKey) {
      setChatError('Gemini API キーを入力してください')
      return
    }
    const historyBeforeAsk = chat
    setChat([...historyBeforeAsk, { role: 'user', text: trimmed }])
    setQuestion('')
    setAsking(true)
    setChatError(null)
    try {
      const answer = await askAboutTrends(geminiApiKey, videos, analysis, historyBeforeAsk, trimmed)
      setChat([
        ...historyBeforeAsk,
        { role: 'user', text: trimmed },
        { role: 'model', text: answer }
      ])
    } catch (e) {
      // Drop the unanswered question so a retry doesn't send it twice, and put the
      // text back in the box so it isn't lost.
      setChat(historyBeforeAsk)
      setQuestion(trimmed)
      setChatError(formatIpcError(e))
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="panel game-trend-panel">
      <div className="panel-header">
        <h2>ゲームトレンド分析</h2>
      </div>
      <p className="hint-text">
        YouTube公式APIで「ゲームカテゴリの急上昇動画(日本)」を取得し、そのタイトルとサムネイル画像だけを根拠にGemini(AI)がゲーム名・バズる要素・視覚傾向を分析します。実行するたびに最新の急上昇データを取得します。
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
        {envKeySources.geminiApiKey && (
          <p className="hint-text">.envファイルの設定値を使用中(入力欄で上書きできます)</p>
        )}
      </div>
      <div className="youtube-field">
        <label>分析の観点(任意)</label>
        <textarea
          className="game-trend-instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={2}
          placeholder="例: ホラーゲーム中心で見たい / 顔出しなしで作れるものを重視して"
        />
        <p className="hint-text">
          書いておくと、分析の切り口をここに寄せます。空欄でも通常どおり分析します。
        </p>
      </div>
      <button className="primary-button" onClick={handleRefresh} disabled={loading}>
        <SparklesIcon width={13} height={13} />
        {loading ? '分析中...' : '最新トレンドを分析'}
      </button>
      {error && <p className="error-text">{error}</p>}

      {analysis && analysis.recommendedGame && (
        <div className="game-trend-recommendation">
          <h3>
            <WandIcon width={14} height={14} />
            次にやるべきゲーム
          </h3>
          <p className="game-trend-recommendation-name">{analysis.recommendedGame.gameName}</p>
          <p className="game-trend-recommendation-reason">{analysis.recommendedGame.reason}</p>
        </div>
      )}

      {videos.length > 0 && (
        <div className="game-trend-chat">
          <h3>
            <MegaphoneIcon width={13} height={13} />
            このトレンドについて質問する
          </h3>
          <p className="hint-text">
            上で取得した急上昇動画リストと分析結果だけを根拠に答えます。データから分からないことは「分からない」と答えます。
          </p>
          {chat.length > 0 && (
            <div className="game-trend-chat-log">
              {chat.map((turn, i) => (
                <div key={i} className={`game-trend-chat-turn ${turn.role}`}>
                  {turn.text}
                </div>
              ))}
              {asking && <div className="game-trend-chat-turn model pending">回答を作成中...</div>}
            </div>
          )}
          {chat.length === 0 && !asking && (
            <div className="game-trend-chat-suggestions">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button key={q} className="small-button" onClick={() => handleAsk(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}
          <textarea
            className="game-trend-chat-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                handleAsk(question)
              }
            }}
            rows={2}
            placeholder="聞きたいことを書いてください(Ctrl+Enterで送信)"
          />
          <div className="game-trend-chat-actions">
            <button
              className="primary-button"
              onClick={() => handleAsk(question)}
              disabled={asking || question.trim() === ''}
            >
              {asking ? '回答を作成中...' : '質問する'}
            </button>
            {chat.length > 0 && (
              <button
                className="small-button"
                onClick={() => {
                  setChat([])
                  setChatError(null)
                }}
                disabled={asking}
              >
                会話をクリア
              </button>
            )}
          </div>
          {chatError && <p className="error-text">{chatError}</p>}
        </div>
      )}

      {comparison && (comparison.newGames.length > 0 || comparison.sustainedGames.length > 0) && (
        <div className="game-trend-comparison">
          <h3>前回({formatRelativeTime(comparison.previousTimestamp)})との比較</h3>
          {comparison.newGames.length > 0 && (
            <p>
              <span className="trend-comparison-badge new">新規</span>
              {comparison.newGames.join(' / ')}
            </p>
          )}
          {comparison.sustainedGames.length > 0 && (
            <p>
              <span className="trend-comparison-badge sustained">継続</span>
              {comparison.sustainedGames.join(' / ')}
            </p>
          )}
        </div>
      )}

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

      {analysis && analysis.viralFactors.length > 0 && (
        <div className="game-trend-viral">
          <h3>バズる要素(タイトルのフック手法)</h3>
          {analysis.viralFactors.map((f, i) => (
            <div key={i} className="game-trend-viral-card">
              <span className="game-trend-hook-badge">{f.hookType}</span>
              <p className="game-trend-viral-example" title={f.exampleTitle}>
                「{f.exampleTitle}」
              </p>
              <p className="hint-text">{f.explanation}</p>
            </div>
          ))}
        </div>
      )}

      {analysis && analysis.thumbnailInsight && (
        <div className="game-trend-thumbnail-insight">
          <h3>
            <ImageIcon width={13} height={13} />
            サムネイルの視覚傾向
          </h3>
          <ul>
            <li>配色: {analysis.thumbnailInsight.colorTendency}</li>
            <li>構図: {analysis.thumbnailInsight.compositionTendency}</li>
            <li>文字入れ: {analysis.thumbnailInsight.textOverlayTendency}</li>
          </ul>
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

import { useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { fetchTrendingGamingVideos, YouTubeVideoInfo } from '../lib/youtube'
import {
  analyzeGamingTrends,
  askAboutTrends,
  GameTrendAnalysis,
  ResearchProgress,
  TrendChatTurn,
  VERIFY_TOP_N,
  VERIFY_WINDOW_DAYS
} from '../lib/gameTrendAnalysis'
import type { AnalyzedGame } from '../lib/gameTrendAnalysis'
import { SCORE_WEIGHTS } from '../lib/gameResearch'
import { compareTrend, saveTrendSnapshot, TrendComparison } from '../lib/trendHistory'
import { formatIpcError } from '../lib/ipcError'
import { openExternalLink } from '../lib/openExternalLink'
import {
  KeyIcon,
  SparklesIcon,
  ExternalLinkIcon,
  TargetIcon,
  ImageIcon,
  WandIcon,
  MegaphoneIcon,
  ActivityIcon,
  SearchIcon
} from './icons'

// Before any data is fetched the questions can't refer to "this list", so the
// starting suggestions differ from the ones offered once results are on screen.
const SUGGESTED_QUESTIONS_BEFORE_FETCH = [
  '今ゲームのショートで伸びてるのは？',
  '今日1本作るなら何を撮ればいい？',
  '伸びてる動画のタイトルの付け方を教えて'
]

const SUGGESTED_QUESTIONS_AFTER_FETCH = [
  'この中で初心者でも撮りやすいのはどれ？',
  '1位と2位の差はどこ？',
  '明日1本作るなら何をどう撮ればいい？'
]

function formatViews(views: number): string {
  if (!Number.isFinite(views)) return '不明'
  if (views >= 10000) return `${(views / 10000).toFixed(1)}万回`
  return `${views}回`
}

/** 速度は桁が大きく振れるので、万を超えたら「万回/時」に落として読めるようにする */
function formatPerHour(value: number): string {
  if (!Number.isFinite(value)) return '不明'
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万回/時`
  return `${Math.round(value).toLocaleString('ja-JP')}回/時`
}

function formatHoursAgo(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '不明'
  if (hours < 1) return '1時間以内'
  if (hours < 24) return `${Math.round(hours)}時間前`
  return `${Math.round(hours / 24)}日前`
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  const hours = Math.round(diffMs / (1000 * 60 * 60))
  if (hours < 1) return '1時間以内'
  if (hours < 24) return `${hours}時間前`
  return `${Math.round(hours / 24)}日前`
}

function progressLabel(progress: ResearchProgress | null): string {
  if (!progress) return '急上昇データを取得中...'
  switch (progress.phase) {
    case 'attribute':
      return 'タイトルからゲーム名を判定中...'
    case 'verify':
      return `候補をYouTube検索で裏取り中... (${progress.done ?? 0}/${progress.total ?? 0})`
    case 'compose':
      return '順位の解説を作成中...'
  }
}

/** 内訳を「満点のうち何点か」で描く。どの項目で稼いだ順位なのかが一目で分かる */
function ScoreBar({
  label,
  value,
  max
}: {
  label: string
  value: number
  max: number
}): React.JSX.Element {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  return (
    <div className="game-score-bar">
      <span className="game-score-bar-label">{label}</span>
      <span className="game-score-bar-track">
        <span className="game-score-bar-fill" style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="game-score-bar-value">
        {value}/{max}
      </span>
    </div>
  )
}

function RankedGameCard({
  game,
  rank,
  onError
}: {
  game: AnalyzedGame
  rank: number
  onError: (message: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(rank === 1)
  const s = game.stats
  return (
    <div className={`game-rank-card${rank === 1 ? ' top' : ''}`}>
      <div className="game-rank-head">
        <span className="game-rank-badge">{rank}位</span>
        <span className="game-rank-name">
          <TargetIcon width={13} height={13} />
          {s.displayName}
        </span>
        <span className="game-rank-score">{game.score.total}点</span>
      </div>
      <div className="game-rank-facts">
        <span>急上昇 {s.videoCount}本</span>
        <span>{s.channelCount}チャンネル</span>
        <span>速度中央値 {formatPerHour(s.medianViewsPerHour)}</span>
        <span>最新 {formatHoursAgo(s.newestHoursAgo)}</span>
        {game.verification ? (
          <span className={game.verification.shortsFound > 0 ? 'verified' : 'verified none'}>
            <SearchIcon width={10} height={10} />
            直近{game.verification.windowDays}日のショート {game.verification.shortsFound}本
            {game.verification.shortsFound > 0
              ? ` / ${formatPerHour(game.verification.medianViewsPerHour)}`
              : ''}
          </span>
        ) : (
          <span className="unverified">裏取り未実施</span>
        )}
      </div>
      {game.whyNow && <p className="game-rank-why">{game.whyNow}</p>}
      {game.sceneSuggestion && <p className="game-rank-scene">{game.sceneSuggestion}</p>}
      <button className="small-button game-rank-toggle" onClick={() => setOpen(!open)}>
        {open ? '根拠を隠す' : `根拠を見る(${s.videoCount}本 / 採点の内訳)`}
      </button>
      {open && (
        <div className="game-rank-detail">
          <div className="game-score-bars">
            <ScoreBar label="勢い" value={game.score.momentum} max={SCORE_WEIGHTS.momentum} />
            <ScoreBar label="新しさ" value={game.score.freshness} max={SCORE_WEIGHTS.freshness} />
            <ScoreBar label="広がり" value={game.score.spread} max={SCORE_WEIGHTS.spread} />
            <ScoreBar
              label="ショート適性"
              value={game.score.shortsFit}
              max={SCORE_WEIGHTS.shortsFit}
            />
          </div>
          <ul className="game-trend-evidence">
            {s.videos.map((v) => (
              <li key={v.id} title={v.title}>
                <button
                  className="game-evidence-link"
                  onClick={() =>
                    void openExternalLink(`https://www.youtube.com/watch?v=${v.id}`, onError)
                  }
                >
                  {v.title}
                </button>
                <span className="game-evidence-meta">
                  {v.channelTitle} ・ {formatViews(v.viewCount)} ・ {formatHoursAgo(v.hoursAgo)}
                  {v.isShort ? ' ・ ショート' : ''}
                </span>
              </li>
            ))}
          </ul>
          {game.verification?.topVideo && (
            <p className="hint-text">
              裏取りで最も伸びていたショート: 「{game.verification.topVideo.title}」(
              {formatViews(game.verification.topVideo.viewCount)})
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function GameTrendPanel(): React.JSX.Element {
  const youtubeApiKey = useSettingsStore((s) => s.youtubeApiKey)
  const setYoutubeApiKey = useSettingsStore((s) => s.setYoutubeApiKey)
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey)
  const setGeminiApiKey = useSettingsStore((s) => s.setGeminiApiKey)
  const envKeySources = useSettingsStore((s) => s.envKeySources)
  const verifyEnabled = useSettingsStore((s) => s.trendVerifyEnabled)
  const setVerifyEnabled = useSettingsStore((s) => s.setTrendVerifyEnabled)

  const [videos, setVideos] = useState<YouTubeVideoInfo[]>([])
  const [analysis, setAnalysis] = useState<GameTrendAnalysis | null>(null)
  const [comparison, setComparison] = useState<TrendComparison | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<ResearchProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [chat, setChat] = useState<TrendChatTurn[]>([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [fetchingForQuestion, setFetchingForQuestion] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)

  const hasData = videos.length > 0

  // Returns the freshly fetched data rather than only writing it to state, so a caller
  // that needs it in the same tick (asking a question before any fetch has happened)
  // doesn't have to wait for a re-render to read it back.
  async function fetchTrendData(): Promise<{
    videos: YouTubeVideoInfo[]
    analysis: GameTrendAnalysis
  }> {
    setProgress(null)
    const trending = await fetchTrendingGamingVideos(youtubeApiKey)
    if (trending.length === 0) {
      throw new Error(
        '急上昇のゲーム動画を取得できませんでした。APIキーと通信環境を確認してください。'
      )
    }
    setVideos(trending)
    const result = await analyzeGamingTrends(geminiApiKey, trending, {
      userInstruction: instruction,
      youtubeApiKey,
      verify: verifyEnabled,
      onProgress: setProgress
    })
    setAnalysis(result)
    const gameNames = result.rankedGames.map((g) => g.stats.displayName)
    setComparison(compareTrend(gameNames))
    saveTrendSnapshot(gameNames)
    return { videos: trending, analysis: result }
  }

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
      await fetchTrendData()
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  async function handleAsk(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || asking || loading) return
    if (!geminiApiKey) {
      setChatError('Gemini API キーを入力してください')
      return
    }
    // Asking without having fetched anything yet is allowed: the trend data is
    // fetched first and the question is then answered against it, so the user never
    // has to remember to press "分析" before they can ask something.
    const needsFetch = !hasData
    if (needsFetch && !youtubeApiKey) {
      setChatError(
        'YouTube Data API キーを入力してください(質問に答えるため、先に急上昇データを取得します)'
      )
      return
    }
    const historyBeforeAsk = chat
    setChat([...historyBeforeAsk, { role: 'user', text: trimmed }])
    setQuestion('')
    setAsking(true)
    setChatError(null)
    try {
      let data: { videos: YouTubeVideoInfo[]; analysis: GameTrendAnalysis | null } = {
        videos,
        analysis
      }
      if (needsFetch) {
        setFetchingForQuestion(true)
        data = await fetchTrendData()
        setFetchingForQuestion(false)
      }
      const answer = await askAboutTrends(
        geminiApiKey,
        data.videos,
        data.analysis,
        historyBeforeAsk,
        trimmed
      )
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
      setFetchingForQuestion(false)
      setProgress(null)
    }
  }

  const busy = loading || asking

  return (
    <div className="panel game-trend-panel">
      <div className="panel-header">
        <h2>ゲームリサーチ</h2>
      </div>
      <p className="hint-text">
        YouTube公式APIで「ゲームカテゴリの急上昇動画(日本)」を取得し、タイトルからゲーム名をAIが判定します。
        件数・再生速度(再生数÷公開からの経過時間)・チャンネル数・新しさの集計と順位付けはAIではなくアプリ側の計算で行い、AIには順位の解説だけを書かせます。
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
          書いておくと、解説の切り口をここに寄せます(順位と数値は変わりません)。
        </p>
      </div>
      <label className="game-trend-verify-toggle">
        <input
          type="checkbox"
          checked={verifyEnabled}
          onChange={(e) => setVerifyEnabled(e.target.checked)}
          disabled={busy}
        />
        <span>
          上位{VERIFY_TOP_N}件をYouTube検索で裏取りする(精度優先)
          <span className="hint-text">
            候補ごとに直近{VERIFY_WINDOW_DAYS}
            日のショートを検索し、実際に回っているかを確かめてから順位を付け直します。
            精度は上がりますが、YouTube APIの消費が1回の分析あたり最大{VERIFY_TOP_N}
            回分の検索(既定の無料枠のおよそ5%)増えます。
          </span>
        </span>
      </label>
      <button className="primary-button" onClick={handleRefresh} disabled={busy}>
        <SparklesIcon width={13} height={13} />
        {loading ? progressLabel(progress) : '最新トレンドを分析'}
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

      {analysis && analysis.rankedGames.length === 0 && (
        <p className="hint-text">
          取得した{analysis.analyzedVideoCount}
          本のタイトルからは、ゲーム名を確実に読み取れる動画がありませんでした(雑談・切り抜きなどが並んでいる時間帯に起きます)。時間をおいて再実行してください。
        </p>
      )}

      {analysis && analysis.rankedGames.length > 0 && (
        <div className="game-trend-ranking">
          <h3>
            <ActivityIcon width={13} height={13} />
            いま撮るべきゲーム(スコア順)
          </h3>
          <p className="hint-text">
            急上昇{analysis.analyzedVideoCount}本を集計。
            {analysis.unattributedCount > 0 &&
              `うち${analysis.unattributedCount}本はゲーム名を特定できず除外。`}
            {analysis.verifiedCount > 0
              ? `上位${analysis.verifiedCount}件は直近${VERIFY_WINDOW_DAYS}日のショート検索で裏取り済み。`
              : '裏取りは未実施(ショート適性は控えめに見積もった値です)。'}
          </p>
          {analysis.rankedGames.map((game, i) => (
            <RankedGameCard key={game.stats.key} game={game} rank={i + 1} onError={setError} />
          ))}
        </div>
      )}

      <div className="game-trend-chat">
        <h3>
          <MegaphoneIcon width={13} height={13} />
          {hasData ? 'このトレンドについて質問する' : 'トレンドについて質問する'}
        </h3>
        <p className="hint-text">
          {hasData
            ? '上で取得した急上昇動画リストと集計結果だけを根拠に答えます。データから分からないことは「分からない」と答えます。'
            : 'そのまま質問できます。まだ取得していない場合は、急上昇データを自動で取得してから答えます(分析ボタンを先に押す必要はありません)。'}
        </p>
        {chat.length > 0 && (
          <div className="game-trend-chat-log">
            {chat.map((turn, i) => (
              <div key={i} className={`game-trend-chat-turn ${turn.role}`}>
                {turn.text}
              </div>
            ))}
            {asking && (
              <div className="game-trend-chat-turn model pending">
                {fetchingForQuestion ? progressLabel(progress) : '回答を作成中...'}
              </div>
            )}
          </div>
        )}
        {chat.length === 0 && !asking && (
          <div className="game-trend-chat-suggestions">
            {(hasData ? SUGGESTED_QUESTIONS_AFTER_FETCH : SUGGESTED_QUESTIONS_BEFORE_FETCH).map(
              (q) => (
                <button
                  key={q}
                  className="small-button"
                  onClick={() => handleAsk(q)}
                  disabled={loading}
                >
                  {q}
                </button>
              )
            )}
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
            disabled={busy || question.trim() === ''}
          >
            {asking
              ? fetchingForQuestion
                ? 'データを取得中...'
                : '回答を作成中...'
              : hasData
                ? '質問する'
                : '取得して質問する'}
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
                      void openExternalLink(`https://www.youtube.com/watch?v=${v.id}`, setError)
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

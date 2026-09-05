import { useState } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import {
  MAX_COMPETITORS,
  analyzeChannel,
  askAboutChannel,
  type ChannelAnalysisResult,
  type ChannelChatTurn,
  type ChannelProgress,
  type ChannelReport,
  type NewsItem,
  type VideoIdea
} from '../lib/channelAnalysis'
import { MATURITY_DAYS, type RatedVideo } from '../lib/channelAnalytics'
import type { WebSource } from '../lib/gemini'
import { describeChannelRef, parseChannelInput } from '../lib/channelUrl'
import {
  WEEKDAY_LABELS,
  formatCount,
  formatDurationSeconds,
  formatHoursAgo,
  formatRatio,
  formatViews
} from '../lib/formatUnits'
import { formatIpcError } from '../lib/ipcError'
import { openExternalLink } from '../lib/openExternalLink'
import {
  ActivityIcon,
  AlertTriangleIcon,
  ExternalLinkIcon,
  GaugeIcon,
  KeyIcon,
  MegaphoneIcon,
  SearchIcon,
  SparklesIcon,
  TargetIcon,
  WandIcon
} from './icons'

const SUGGESTED_QUESTIONS = [
  '直近で伸び悩んでいる原因は？',
  'ショートと長尺、どちらに寄せるべき？',
  '競合と比べて足りないものは？',
  '来週の投稿ネタを3つ出して'
]

function progressLabel(progress: ChannelProgress | null): string {
  if (!progress) return '準備中...'
  switch (progress.phase) {
    case 'resolve':
      return 'チャンネルを特定中...'
    case 'videos':
      return `投稿動画を取得中... (${progress.done ?? 0}/${progress.total ?? 0}${
        progress.label ? ` ${progress.label}` : ''
      })`
    case 'research':
      return '外部のニュース・トレンドを検索中...'
    case 'compose':
      return '診断と企画案を作成中...'
  }
}

function SourceLinks({
  sources,
  onError
}: {
  sources: WebSource[]
  onError: (message: string) => void
}): React.JSX.Element | null {
  if (sources.length === 0) return null
  return (
    <div className="channel-sources">
      {sources.map((s) => (
        <button
          key={s.uri}
          className="channel-source-chip"
          title={s.title}
          onClick={() => void openExternalLink(s.uri, onError)}
        >
          <ExternalLinkIcon width={10} height={10} />
          {s.domain || s.title}
        </button>
      ))}
    </div>
  )
}

function StatCard({
  label,
  value,
  note
}: {
  label: string
  value: string
  note?: string
}): React.JSX.Element {
  return (
    <div className="channel-stat-card">
      <span className="channel-stat-label">{label}</span>
      <span className="channel-stat-value">{value}</span>
      {note && <span className="channel-stat-note">{note}</span>}
    </div>
  )
}

function VideoRow({
  rated,
  onError
}: {
  rated: RatedVideo
  onError: (message: string) => void
}): React.JSX.Element {
  return (
    <li className="channel-video-row">
      <button
        className="channel-video-title"
        title={rated.video.title}
        onClick={() =>
          void openExternalLink(`https://www.youtube.com/watch?v=${rated.video.id}`, onError)
        }
      >
        {rated.video.title}
      </button>
      <span className="channel-video-meta">
        {formatViews(rated.video.viewCount)} ・{' '}
        {rated.performanceRatio === null
          ? '平常比なし'
          : `平常比 ${formatRatio(rated.performanceRatio)}`}{' '}
        ・ {formatHoursAgo(rated.video.hoursAgo)} ・ {rated.video.isShort ? 'ショート' : '長尺'}
      </span>
    </li>
  )
}

function VideoList({
  title,
  videos,
  onError
}: {
  title: string
  videos: RatedVideo[]
  onError: (message: string) => void
}): React.JSX.Element | null {
  if (videos.length === 0) return null
  return (
    <div className="channel-video-list">
      <h4>{title}</h4>
      <ul>
        {videos.map((r) => (
          <VideoRow key={r.video.id} rated={r} onError={onError} />
        ))}
      </ul>
    </div>
  )
}

function NewsCard({
  item,
  onError
}: {
  item: NewsItem
  onError: (message: string) => void
}): React.JSX.Element {
  return (
    <div className="channel-news-card">
      <div className="channel-news-head">
        <span className="channel-news-date">{item.dateHint}</span>
        <span className="channel-news-headline">{item.headline}</span>
      </div>
      {item.whyItMatters && <p className="channel-news-why">{item.whyItMatters}</p>}
      <SourceLinks sources={item.sources} onError={onError} />
    </div>
  )
}

function IdeaCard({
  idea,
  index,
  onError
}: {
  idea: VideoIdea
  index: number
  onError: (message: string) => void
}): React.JSX.Element {
  return (
    <div className="channel-idea-card">
      <div className="channel-idea-head">
        <span className="channel-idea-number">案{index}</span>
        <span className={`channel-format-badge ${idea.format}`}>
          {idea.format === 'shorts' ? 'ショート' : '長尺'}
        </span>
      </div>
      <p className="channel-idea-title">{idea.title}</p>
      {idea.outline && <p className="channel-idea-outline">{idea.outline}</p>}
      {idea.whyNow && <p className="channel-idea-why">{idea.whyNow}</p>}
      {idea.evidence.length > 0 && (
        <ul className="channel-idea-evidence">
          {idea.evidence.map((r) => (
            <VideoRow key={r.video.id} rated={r} onError={onError} />
          ))}
        </ul>
      )}
      {idea.news.length > 0 && (
        <div className="channel-idea-news">
          {idea.news.map((n, i) => (
            <span key={i} className="channel-idea-news-chip" title={n.whyItMatters}>
              {n.dateHint} {n.headline}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ChannelSummary({ report }: { report: ChannelReport }): React.JSX.Element {
  const { channel, analytics } = report
  return (
    <div className="channel-identity">
      {channel.thumbnailUrl && <img src={channel.thumbnailUrl} alt={channel.title} />}
      <div>
        <div className="channel-identity-name">
          {channel.title}
          {channel.handle && <span className="channel-identity-handle">{channel.handle}</span>}
        </div>
        <div className="channel-identity-meta">
          登録者 {channel.subscriberCountHidden ? '非公開' : formatCount(channel.subscriberCount)}{' '}
          ・ 総再生 {formatCount(channel.viewCount)} ・ 公開動画 {formatCount(channel.videoCount)}本
        </div>
        <div className="channel-identity-meta">
          分析対象 直近{analytics.analyzedCount}本
          {analytics.windowDays !== null && `(${Math.round(analytics.windowDays)}日ぶん)`} ・
          最新の投稿 {formatHoursAgo(analytics.newestHoursAgo)}
        </div>
      </div>
    </div>
  )
}

function ComparisonTable({ result }: { result: ChannelAnalysisResult }): React.JSX.Element | null {
  if (result.competitors.length === 0) return null
  const rows = [result.primary, ...result.competitors]
  return (
    <div className="channel-block">
      <h3>
        <GaugeIcon width={13} height={13} />
        競合との比較(同じ計算をかけた実測)
      </h3>
      <div className="channel-table-scroll">
        <table className="channel-table">
          <thead>
            <tr>
              <th>チャンネル</th>
              <th>登録者</th>
              <th>平常運転(長尺)</th>
              <th>平常運転(ショート)</th>
              <th>登録者あたり</th>
              <th>週の投稿</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.channel.id} className={i === 0 ? 'primary' : ''}>
                <td title={r.channel.title}>
                  {i === 0 ? '● ' : ''}
                  {r.channel.title}
                </td>
                <td>
                  {r.channel.subscriberCountHidden
                    ? '非公開'
                    : formatCount(r.channel.subscriberCount)}
                </td>
                <td>
                  {r.analytics.long.baselineViews === null
                    ? '—'
                    : formatViews(r.analytics.long.baselineViews)}
                </td>
                <td>
                  {r.analytics.shorts.baselineViews === null
                    ? '—'
                    : formatViews(r.analytics.shorts.baselineViews)}
                </td>
                <td>{r.viewsPerSubscriber === null ? '—' : r.viewsPerSubscriber.toFixed(3)}</td>
                <td>
                  {r.analytics.uploadsPerWeek === null
                    ? '—'
                    : `${r.analytics.uploadsPerWeek.toFixed(1)}本`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint-text">
        平常運転は「公開から{MATURITY_DAYS}
        日以上経った動画の再生数の中央値」。登録者あたりは平常運転÷登録者数で、規模が違うチャンネルどうしを比べるための数字です。
      </p>
    </div>
  )
}

export function ChannelAnalysisPanel(): React.JSX.Element {
  const youtubeApiKey = useSettingsStore((s) => s.youtubeApiKey)
  const setYoutubeApiKey = useSettingsStore((s) => s.setYoutubeApiKey)
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey)
  const setGeminiApiKey = useSettingsStore((s) => s.setGeminiApiKey)
  const envKeySources = useSettingsStore((s) => s.envKeySources)
  const channelInput = useSettingsStore((s) => s.channelInput)
  const setChannelInput = useSettingsStore((s) => s.setChannelInput)
  const channelRivals = useSettingsStore((s) => s.channelRivals)
  const setChannelRivals = useSettingsStore((s) => s.setChannelRivals)
  const researchEnabled = useSettingsStore((s) => s.channelResearchEnabled)
  const setResearchEnabled = useSettingsStore((s) => s.setChannelResearchEnabled)

  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState<ChannelAnalysisResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<ChannelProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showResearch, setShowResearch] = useState(false)

  const [chat, setChat] = useState<(ChannelChatTurn & { sources?: WebSource[] })[]>([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [chatSearch, setChatSearch] = useState(true)
  const [chatError, setChatError] = useState<string | null>(null)

  const parsedRef = parseChannelInput(channelInput)
  const rivalLines = channelRivals
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  async function handleAnalyze(): Promise<void> {
    if (!youtubeApiKey) {
      setError('YouTube Data API キーを入力してください')
      return
    }
    if (!geminiApiKey) {
      setError('Gemini API キーを入力してください')
      return
    }
    if (!parsedRef) {
      setError('チャンネルのURL・ハンドル(@から始まる名前)・チャンネル名を入力してください')
      return
    }
    setLoading(true)
    setError(null)
    setResult(null)
    // 分析対象が変わった時点で、前の会話は別のチャンネルの話になる
    setChat([])
    setChatError(null)
    try {
      const analysis = await analyzeChannel(youtubeApiKey, geminiApiKey, channelInput, {
        competitorInputs: rivalLines,
        research: researchEnabled,
        userInstruction: instruction,
        onProgress: setProgress
      })
      setResult(analysis)
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  async function handleAsk(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed || asking || loading || !result) return
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
      const answer = await askAboutChannel(
        geminiApiKey,
        result,
        historyBeforeAsk.map(({ role, text }) => ({ role, text })),
        trimmed,
        chatSearch
      )
      setChat([
        ...historyBeforeAsk,
        { role: 'user', text: trimmed },
        { role: 'model', text: answer.text, sources: answer.sources }
      ])
    } catch (e) {
      // 答えられなかった質問は消し、入力欄に戻す(二重送信と、書いた文の消失を防ぐ)
      setChat(historyBeforeAsk)
      setQuestion(trimmed)
      setChatError(formatIpcError(e))
    } finally {
      setAsking(false)
    }
  }

  const analytics = result?.primary.analytics
  const busy = loading || asking

  return (
    <div className="panel channel-panel">
      <div className="panel-header">
        <h2>チャンネル分析</h2>
      </div>
      <p className="hint-text">
        チャンネルのURLを貼ると、公開されている投稿動画を実際に集計して「平常運転」を出し、どの動画がそれを超えたかを測ります。
        さらにGoogle検索でそのチャンネルの題材に関する外部のニュース・予定を調べ、実測と外の出来事の両方を根拠に次の企画を出します。
        自分以外のチャンネルにも同じ計算をかけられます。
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
        <label>分析するチャンネル</label>
        <input
          type="text"
          value={channelInput}
          onChange={(e) => setChannelInput(e.target.value)}
          placeholder="https://www.youtube.com/@yourchannel"
        />
        <p className="hint-text">
          {channelInput.trim() === ''
            ? 'URL・@ハンドル・チャンネルID・動画のURL・チャンネル名、どれでも構いません。'
            : parsedRef
              ? `${describeChannelRef(parsedRef)} として調べます。`
              : 'YouTubeのURLとして読めませんでした。@ハンドルかチャンネル名を入れてみてください。'}
        </p>
      </div>

      <div className="youtube-field">
        <label>比較するチャンネル(任意・1行に1つ・最大{MAX_COMPETITORS}件)</label>
        <textarea
          className="channel-rivals-input"
          value={channelRivals}
          onChange={(e) => setChannelRivals(e.target.value)}
          rows={2}
          placeholder="https://www.youtube.com/@rival1"
        />
        <p className="hint-text">
          同じ計算を競合にもかけて並べます。登録者あたりの再生など、単体では良し悪しの決まらない数字が読めるようになります。
        </p>
        {rivalLines.length > MAX_COMPETITORS && (
          <p className="hint-text">
            {`${rivalLines.length}件入力されていますが、比較するのは先頭の${MAX_COMPETITORS}件だけです。`}
          </p>
        )}
      </div>

      <div className="youtube-field">
        <label>分析の観点(任意)</label>
        <textarea
          className="channel-rivals-input"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={2}
          placeholder="例: ショートを伸ばしたい / 顔出しなしで作れる企画を中心に"
        />
      </div>

      <label className="channel-toggle">
        <input
          type="checkbox"
          checked={researchEnabled}
          onChange={(e) => setResearchEnabled(e.target.checked)}
          disabled={busy}
        />
        <span>
          外部のニュース・トレンドも調べる
          <span className="hint-text">
            Google検索でチャンネルの題材に関する直近の出来事と今後の予定を調べ、出典付きで提示します。企画案の「なぜ今か」がチャンネルの外の事実に接地します。
          </span>
        </span>
      </label>

      <button className="primary-button" onClick={handleAnalyze} disabled={busy}>
        <SparklesIcon width={13} height={13} />
        {loading ? progressLabel(progress) : 'チャンネルを分析'}
      </button>
      {error && <p className="error-text">{error}</p>}

      {result && analytics && (
        <>
          <ChannelSummary report={result.primary} />

          <div className="channel-stat-grid">
            <StatCard
              label="平常運転(長尺)"
              value={
                analytics.long.baselineViews === null
                  ? '測定不能'
                  : formatViews(analytics.long.baselineViews)
              }
              note={
                analytics.long.count === 0
                  ? '長尺の投稿なし'
                  : `${analytics.long.count}本 / 中央値の尺 ${formatDurationSeconds(analytics.long.medianDurationSeconds)}`
              }
            />
            <StatCard
              label="平常運転(ショート)"
              value={
                analytics.shorts.baselineViews === null
                  ? '測定不能'
                  : formatViews(analytics.shorts.baselineViews)
              }
              note={
                analytics.shorts.count === 0
                  ? 'ショートの投稿なし'
                  : `${analytics.shorts.count}本 / 中央値の尺 ${formatDurationSeconds(analytics.shorts.medianDurationSeconds)}`
              }
            />
            <StatCard
              label="投稿頻度"
              value={
                analytics.uploadsPerWeek === null
                  ? '測定不能'
                  : `週${analytics.uploadsPerWeek.toFixed(1)}本`
              }
              note="直近90日"
            />
            <StatCard
              label="伸びの推移"
              value={
                analytics.trend.changeRatio === null
                  ? '測定不能'
                  : `${analytics.trend.changeRatio.toFixed(2)}倍`
              }
              note={
                analytics.trend.changeRatio === null
                  ? '比較に足りる本数がない'
                  : `直近90日 ${formatViews(analytics.trend.recentMedianViews)} / 前の90日 ${formatViews(analytics.trend.previousMedianViews)}`
              }
            />
            {result.primary.viewsPerSubscriber !== null && (
              <StatCard
                label="登録者あたりの再生"
                value={result.primary.viewsPerSubscriber.toFixed(3)}
                note="平常運転 ÷ 登録者数"
              />
            )}
          </div>

          <p className="channel-limitation">
            <AlertTriangleIcon width={12} height={12} />
            {
              'クリック率・視聴維持率・インプレッション・視聴者層は、公開APIでは取得できません(所有者本人向けのデータです)。ここに出している数字はすべて、誰でも見られる公開データから計算したものです。'
            }
          </p>

          {result.insight.summary && (
            <div className="channel-block channel-diagnosis">
              <h3>
                <ActivityIcon width={13} height={13} />
                いまの状態
              </h3>
              <p>{result.insight.summary}</p>
              {result.insight.strengths.length > 0 && (
                <>
                  <h4>強み</h4>
                  <ul className="channel-bullets good">
                    {result.insight.strengths.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </>
              )}
              {result.insight.weaknesses.length > 0 && (
                <>
                  <h4>弱み</h4>
                  <ul className="channel-bullets bad">
                    {result.insight.weaknesses.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {result.insight.ideas.length > 0 && (
            <div className="channel-block">
              <h3>
                <WandIcon width={13} height={13} />
                次に作る企画案
              </h3>
              {result.insight.ideas.map((idea, i) => (
                <IdeaCard key={i} idea={idea} index={i + 1} onError={setError} />
              ))}
            </div>
          )}

          {result.insight.news.length > 0 && (
            <div className="channel-block">
              <h3>
                <SearchIcon width={13} height={13} />
                外部のニュース・予定
              </h3>
              {result.insight.news.map((item, i) => (
                <NewsCard key={i} item={item} onError={setError} />
              ))}
              {result.insight.searchQueries.length > 0 && (
                <p className="hint-text">
                  検索に使った語: {result.insight.searchQueries.join(' / ')}
                </p>
              )}
              {result.insight.researchText && (
                <>
                  <button className="small-button" onClick={() => setShowResearch(!showResearch)}>
                    {showResearch ? '調査結果の原文を隠す' : '調査結果の原文を見る'}
                  </button>
                  {showResearch && (
                    <pre className="channel-research-raw">{result.insight.researchText}</pre>
                  )}
                </>
              )}
            </div>
          )}

          {researchEnabled && result.insight.news.length === 0 && (
            <p className="hint-text">
              外部の調査結果は得られませんでした(検索が利用できないか、題材に関する直近の情報が見つかりませんでした)。実測にもとづく分析はそのまま有効です。
            </p>
          )}

          <ComparisonTable result={result} />

          <div className="channel-block">
            <h3>
              <TargetIcon width={13} height={13} />
              動画ごとの成績
            </h3>
            <VideoList title="平常より回った動画" videos={analytics.hits} onError={setError} />
            <VideoList
              title="平常に届かなかった動画"
              videos={analytics.misses}
              onError={setError}
            />
            <VideoList
              title={`まだ伸びている途中の動画(公開${MATURITY_DAYS}日未満・平常比は出せない)`}
              videos={analytics.recent}
              onError={setError}
            />
          </div>

          {(analytics.titlePatterns.length > 0 ||
            analytics.weekdays.some((w) => w.medianRatio !== null)) && (
            <div className="channel-block">
              <h3>
                <GaugeIcon width={13} height={13} />
                効いている型
              </h3>
              {analytics.titlePatterns.length > 0 && (
                <ul className="channel-pattern-list">
                  {analytics.titlePatterns.map((p) => (
                    <li key={p.key}>
                      <span className="channel-pattern-label">{p.label}</span>
                      <span className="channel-pattern-values">
                        あり {formatRatio(p.medianRatioWith)}({p.withCount}本) / なし{' '}
                        {formatRatio(p.medianRatioWithout)}({p.withoutCount}本)
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {analytics.weekdays.some((w) => w.medianRatio !== null) && (
                <div className="channel-weekdays">
                  {analytics.weekdays.map((w) => (
                    <span
                      key={w.weekday}
                      className={`channel-weekday${w.medianRatio === null ? ' thin' : ''}`}
                      title={`${w.count}本`}
                    >
                      {WEEKDAY_LABELS[w.weekday]}
                      <b>{w.medianRatio === null ? '—' : formatRatio(w.medianRatio)}</b>
                    </span>
                  ))}
                </div>
              )}
              <p className="hint-text">
                曜日は日本時間。本数が3本に満たない曜日と、両側4本に満たないタイトルの型は、数字を出していません(1本の当たりで法則を作らないため)。
              </p>
            </div>
          )}

          <div className="channel-block channel-chat">
            <h3>
              <MegaphoneIcon width={13} height={13} />
              このチャンネルについて質問する
            </h3>
            <p className="hint-text">
              上の実測と外部調査の結果を根拠に答えます。取得できていない指標(クリック率など)は「取得できない」と答えます。
            </p>
            <label className="channel-toggle compact">
              <input
                type="checkbox"
                checked={chatSearch}
                onChange={(e) => setChatSearch(e.target.checked)}
                disabled={asking}
              />
              <span>答える前にGoogle検索で調べる(外部の最新情報が必要な質問向け)</span>
            </label>
            {chat.length > 0 && (
              <div className="game-trend-chat-log">
                {chat.map((turn, i) => (
                  <div key={i} className={`game-trend-chat-turn ${turn.role}`}>
                    {turn.text}
                    {turn.sources && turn.sources.length > 0 && (
                      <SourceLinks sources={turn.sources} onError={setError} />
                    )}
                  </div>
                ))}
                {asking && (
                  <div className="game-trend-chat-turn model pending">回答を作成中...</div>
                )}
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
                disabled={busy || question.trim() === ''}
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
        </>
      )}
    </div>
  )
}

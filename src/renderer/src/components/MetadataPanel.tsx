import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { buildTimedClips, totalTimelineDuration, findTimedClipAt } from '../lib/timelineMath'
import {
  generateVideoMetadata,
  regenerateTitles,
  regeneratePinnedComment,
  VideoMetadata
} from '../lib/metadataGeneration'
import { formatIpcError } from '../lib/ipcError'
import { KeyIcon, SparklesIcon, CopyIcon, MegaphoneIcon, ShuffleIcon } from './icons'

const FRAME_FRACTIONS = [0.15, 0.5, 0.85]
const FRAME_WIDTH = 320
const FRAME_HEIGHT = 568

function buildTranscript(project: ReturnType<typeof useProjectStore.getState>['project']): string {
  return project.textOverlays
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
    .map((o) => o.text)
    .join('\n')
}

export function MetadataPanel(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const projectId = useProjectStore((s) => s.project.id)
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey)
  const setGeminiApiKey = useSettingsStore((s) => s.setGeminiApiKey)
  const envKeySources = useSettingsStore((s) => s.envKeySources)

  const [language, setLanguage] = useState('japanese')
  const [extraContext, setExtraContext] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<VideoMetadata | null>(null)
  const [frames, setFrames] = useState<string[]>([])
  const [description, setDescription] = useState('')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [regeneratingTitles, setRegeneratingTitles] = useState(false)
  const [regeneratingPinned, setRegeneratingPinned] = useState(false)

  /**
   * 別のプロジェクトを開いた/新規作成したら、AIが作った結果を捨てる。
   *
   * この画面はタブを切り替えても**ずっとマウントされたまま**なので、結果は
   * 明示的に捨てないと残り続ける。残ったままだと、**別の動画の画面で前の動画の
   * タイトル案・概要欄が出て、そのままコピーできてしまう**
   * (実測: Aで生成したあとBを開くと、画面のプロジェクト名は「Bのプロジェクト」なのに
   * タイトル案は「A案のタイトル1/2」、概要欄は「Aの概要欄」のままだった)。
   * `frames` も同じ——再生成のときに**前の動画のサムネ画像**をAIへ送ってしまう。
   *
   * 捨てるのは**AIが作った結果だけ**。言語・補足情報は利用者が打った値なので残す
   * (AIショートの編集方針を残しているのと同じ扱い)。
   * 判定は `project.id`。保存・読込を通して保たれ、素材やテロップを足しただけでは
   * 変わらないので、編集のたびに消えることはない。
   */
  useEffect(() => {
    // 外部から取ってきた結果を捨てる副作用。props から導ける値ではない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResult(null)
    setDescription('')
    setFrames([])
    setError(null)
  }, [projectId])

  function copy(key: string, text: string): void {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500)
    })
  }

  async function handleGenerate(): Promise<void> {
    if (!geminiApiKey) {
      setError('Gemini API キーを入力してください')
      return
    }
    const timedClips = buildTimedClips(project)
    const total = totalTimelineDuration(timedClips)
    if (total <= 0) {
      setError('タイムラインにクリップがありません')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const capturedFrames: string[] = []
      for (const fraction of FRAME_FRACTIONS) {
        const globalTime = Math.min(total - 0.05, total * fraction)
        const tc = findTimedClipAt(timedClips, globalTime)
        if (!tc || !tc.asset.hasVideo) continue
        const speed = tc.clip.speed || 1
        const localTime = tc.clip.inPoint + (globalTime - tc.start) * speed
        try {
          const dataUrl = await window.api.generateFrame(
            tc.asset.filePath,
            localTime,
            FRAME_WIDTH,
            FRAME_HEIGHT
          )
          capturedFrames.push(dataUrl)
        } catch {
          // Skip frames that fail to extract (e.g. right at a clip boundary).
        }
      }
      setFrames(capturedFrames)
      const transcript = buildTranscript(project)
      const metadata = await generateVideoMetadata(
        geminiApiKey,
        transcript,
        extraContext,
        language,
        capturedFrames
      )
      setResult(metadata)
      setDescription(metadata.description)
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setLoading(false)
    }
  }

  async function handleRegenerateTitles(): Promise<void> {
    if (!geminiApiKey || !result) return
    setRegeneratingTitles(true)
    setError(null)
    try {
      const transcript = buildTranscript(project)
      const newTitles = await regenerateTitles(
        geminiApiKey,
        transcript,
        extraContext,
        language,
        frames,
        result.titles.map((t) => t.title)
      )
      // An unusable response must not wipe the titles already on screen.
      if (newTitles.length === 0) {
        setError('タイトル案を再生成できませんでした。もう一度お試しください。')
        return
      }
      setResult((prev) => (prev ? { ...prev, titles: newTitles } : prev))
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setRegeneratingTitles(false)
    }
  }

  async function handleRegeneratePinned(): Promise<void> {
    if (!geminiApiKey || !result) return
    setRegeneratingPinned(true)
    setError(null)
    try {
      const transcript = buildTranscript(project)
      const newComment = await regeneratePinnedComment(
        geminiApiKey,
        transcript,
        extraContext,
        language,
        frames,
        result.pinnedComment || null
      )
      if (!newComment.trim()) {
        setError('固定コメント案を再生成できませんでした。もう一度お試しください。')
        return
      }
      setResult((prev) => (prev ? { ...prev, pinnedComment: newComment } : prev))
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setRegeneratingPinned(false)
    }
  }

  return (
    <div className="panel metadata-panel">
      <div className="panel-header">
        <h2>投稿準備</h2>
      </div>
      <p className="hint-text">
        タイムラインのテロップ内容とサムネイル候補フレームだけを根拠に、Gemini(AI)がYouTube投稿用のタイトル案・概要欄・ハッシュタグ・固定コメント案を作成します。テロップにない内容は創作しません。
      </p>
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
      <div className="trim-field">
        <label>出力言語</label>
        <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={loading}>
          <option value="japanese">日本語</option>
          <option value="english">英語</option>
        </select>
      </div>
      <div className="trim-field">
        <label>補足情報(任意。テロップだけで内容が伝わらない場合に入力)</label>
        <textarea
          className="metadata-context-input"
          rows={3}
          value={extraContext}
          onChange={(e) => setExtraContext(e.target.value)}
          placeholder="例: ○○というゲームの実況、初見プレイの反応シーン、など"
        />
      </div>
      <button className="primary-button" onClick={handleGenerate} disabled={loading}>
        <SparklesIcon width={13} height={13} />
        {loading ? '生成中...' : result ? '別案を生成' : 'メタデータを生成'}
      </button>
      {error && <p className="error-text">{error}</p>}

      {frames.length > 0 && (
        <div className="metadata-frames">
          {frames.map((f, i) => (
            <img key={i} src={f} alt={`候補フレーム${i + 1}`} />
          ))}
        </div>
      )}

      {result && (
        <>
          <div className="metadata-section">
            <h3>
              タイトル案
              <button
                className="small-button metadata-copy-inline"
                onClick={handleRegenerateTitles}
                disabled={regeneratingTitles}
                title="タイトル案だけを再生成します"
              >
                <ShuffleIcon width={12} height={12} />
                {regeneratingTitles ? '再生成中...' : '再生成'}
              </button>
            </h3>
            {result.titles.map((t, i) => (
              <div key={i} className="metadata-title-item">
                <span className="game-trend-hook-badge">{t.hookType}</span>
                <span className="metadata-title-text">{t.title}</span>
                <span
                  className={`metadata-title-count ${t.title.length > 70 ? 'warn' : ''}`}
                  title="YouTubeの検索結果では長いタイトルが見切れることがあります(目安70文字)"
                >
                  {t.title.length}/100
                </span>
                <button
                  className="icon-button"
                  title="コピー"
                  onClick={() => copy(`title${i}`, t.title)}
                >
                  <CopyIcon width={12} height={12} />
                </button>
                {copiedKey === `title${i}` && <span className="hint-text">コピーしました</span>}
              </div>
            ))}
          </div>

          <div className="metadata-section">
            <h3>
              概要欄
              <button
                className="small-button metadata-copy-inline"
                onClick={() => copy('description', description)}
              >
                <CopyIcon width={12} height={12} />
                コピー
              </button>
              {copiedKey === 'description' && <span className="hint-text">コピーしました</span>}
            </h3>
            <textarea
              className="metadata-description-input"
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <p className="hint-text">{description.length}文字</p>
          </div>

          <div className="metadata-section">
            <h3>
              ハッシュタグ
              <button
                className="small-button metadata-copy-inline"
                onClick={() => copy('hashtags', result.hashtags.map((h) => `#${h}`).join(' '))}
              >
                <CopyIcon width={12} height={12} />
                すべてコピー
              </button>
              {copiedKey === 'hashtags' && <span className="hint-text">コピーしました</span>}
            </h3>
            <div className="metadata-hashtags">
              {result.hashtags.map((h, i) => (
                <span key={i} className="metadata-hashtag-chip">
                  #{h}
                </span>
              ))}
            </div>
          </div>

          {result.pinnedComment && (
            <div className="metadata-section">
              <h3>
                <MegaphoneIcon width={13} height={13} />
                固定コメント案
                <button
                  className="small-button metadata-copy-inline"
                  onClick={handleRegeneratePinned}
                  disabled={regeneratingPinned}
                  title="固定コメント案だけを再生成します"
                >
                  <ShuffleIcon width={12} height={12} />
                  {regeneratingPinned ? '再生成中...' : '再生成'}
                </button>
                <button
                  className="small-button"
                  onClick={() => copy('pinned', result.pinnedComment)}
                >
                  <CopyIcon width={12} height={12} />
                  コピー
                </button>
                {copiedKey === 'pinned' && <span className="hint-text">コピーしました</span>}
              </h3>
              <p>{result.pinnedComment}</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

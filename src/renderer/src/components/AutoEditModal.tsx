import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { useEditPreferenceStore } from '../store/editPreferenceStore'
import { generateAutoEditPatterns } from '../lib/autoEdit'
import { autoFinishTimeline, type AutoFinishResult } from '../lib/autoFinish'
import { formatIpcError } from '../lib/ipcError'
import { TRANSITION_LABELS } from '../lib/autoEditStyles'
import type { AutoEditPattern } from '@shared/types'
import {
  WandIcon,
  PlusIcon,
  RefreshIcon,
  ThumbsUpIcon,
  ThumbsDownIcon,
  SparklesIcon,
  MicIcon,
  ClapperboardIcon,
  TrashIcon
} from './icons'

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath
}

export function AutoEditModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const applyAutoEditPattern = useProjectStore((s) => s.applyAutoEditPattern)
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey)
  const recordFeedback = useEditPreferenceStore((s) => s.recordFeedback)
  const preferenceSummary = useEditPreferenceStore((s) => s.getSummaryText())

  const [useGemini, setUseGemini] = useState(Boolean(geminiApiKey))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [patterns, setPatterns] = useState<AutoEditPattern[]>([])
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [recommendedId, setRecommendedId] = useState<string | undefined>(undefined)
  const [feedback, setFeedback] = useState<Record<string, 'liked' | 'disliked'>>({})
  const [appliedId, setAppliedId] = useState<string | null>(null)
  const [regenToken, setRegenToken] = useState(0)
  const [aiScoredCount, setAiScoredCount] = useState(0)
  const [bgmBeat, setBgmBeat] = useState<{ bpm: number; assetName: string } | null>(null)
  const [referencePath, setReferencePath] = useState<string | null>(null)
  const [referenceStyle, setReferenceStyle] = useState<{
    avgCutSeconds: number
    cutCount: number
  } | null>(null)
  const [finishingId, setFinishingId] = useState<string | null>(null)
  const [finishResult, setFinishResult] = useState<AutoFinishResult | null>(null)
  const [finishError, setFinishError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function run(): Promise<void> {
      setLoading(true)
      setError(null)
      setPatterns([])
      setThumbnails({})
      setFeedback({})
      setAppliedId(null)
      setAiScoredCount(0)
      setBgmBeat(null)
      setReferenceStyle(null)
      try {
        const result = await generateAutoEditPatterns(project.assets, {
          seed: Date.now(),
          geminiApiKey: useGemini ? geminiApiKey : undefined,
          audioTracks: project.audioTracks,
          referenceFilePath: referencePath ?? undefined
        })
        if (cancelled) return
        setPatterns(result.patterns)
        setThumbnails(result.thumbnails)
        setRecommendedId(result.recommendedPatternId)
        setAiScoredCount(result.aiScoredCandidateCount)
        setBgmBeat(result.bgmBeat)
        setReferenceStyle(result.referenceStyle)
      } catch (e) {
        if (!cancelled) setError(formatIpcError(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regenToken, referencePath])

  async function handlePickReference(): Promise<void> {
    const paths = await window.api.selectMediaFiles()
    if (paths.length > 0) setReferencePath(paths[0])
  }

  function handleClearReference(): void {
    setReferencePath(null)
  }

  function handleFeedback(pattern: AutoEditPattern, liked: boolean): void {
    recordFeedback(pattern, liked)
    setFeedback((prev) => ({ ...prev, [pattern.id]: liked ? 'liked' : 'disliked' }))
  }

  function handleApply(pattern: AutoEditPattern): void {
    applyAutoEditPattern(pattern)
    setAppliedId(pattern.id)
  }

  async function handleApplyAndFinish(pattern: AutoEditPattern): Promise<void> {
    applyAutoEditPattern(pattern)
    setAppliedId(pattern.id)
    setFinishingId(pattern.id)
    setFinishError(null)
    setFinishResult(null)
    try {
      const result = await autoFinishTimeline(geminiApiKey || undefined, 'japanese')
      setFinishResult(result)
    } catch (e) {
      setFinishError(formatIpcError(e))
    } finally {
      setFinishingId(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal autoedit-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <WandIcon width={15} height={15} />
          AIおまかせ全自動編集
        </h3>
        <p className="hint-text">
          配置した動画素材からハイライトを検出し、傾向の異なる5パターンの編集案を自動生成します。Gemini
          APIキーを設定している場合は、候補シーンの画像を見せて盛り上がり度を採点させ、選定精度を高めます。気に入ったものはタイムラインに適用し、👍👎で評価すると次回以降の生成に好みが反映されます。
        </p>
        <p className="hint-text autoedit-preference">好みの傾向: {preferenceSummary}</p>
        <div className="autoedit-toolbar">
          <button
            className="small-button"
            onClick={() => setRegenToken((t) => t + 1)}
            disabled={loading}
          >
            <RefreshIcon width={13} height={13} />
            {loading ? '生成中...' : '再生成'}
          </button>
          {geminiApiKey && (
            <label className="autoedit-gemini-toggle">
              <input
                type="checkbox"
                checked={useGemini}
                onChange={(e) => setUseGemini(e.target.checked)}
              />
              <SparklesIcon width={13} height={13} />
              Geminiでハイライト候補を採点して選定精度を上げる
            </label>
          )}
          <button className="small-button" onClick={handlePickReference} disabled={loading}>
            <ClapperboardIcon width={13} height={13} />
            参考動画を選ぶ
          </button>
          {referencePath && (
            <span className="autoedit-reference-chip">
              {basename(referencePath)}
              <button
                className="icon-button"
                title="参考動画の選択を解除"
                onClick={handleClearReference}
                disabled={loading}
              >
                <TrashIcon width={12} height={12} />
              </button>
            </span>
          )}
        </div>
        {!loading && aiScoredCount > 0 && (
          <p className="hint-text autoedit-ai-note">
            <SparklesIcon width={12} height={12} />
            Geminiが候補シーン{aiScoredCount}件を採点し、盛り上がり・表情を編集に反映しました
          </p>
        )}
        {!loading && bgmBeat && (
          <p className="hint-text autoedit-ai-note">
            <SparklesIcon width={12} height={12} />
            BGM「{bgmBeat.assetName}」のテンポ(約{Math.round(bgmBeat.bpm)}{' '}
            BPM)を検出し、ビートシンク編集を追加しました
          </p>
        )}
        {!loading && referencePath && referenceStyle && (
          <p className="hint-text autoedit-ai-note">
            <ClapperboardIcon width={12} height={12} />
            参考動画の平均カット間隔(約{referenceStyle.avgCutSeconds.toFixed(1)}
            秒、カット{referenceStyle.cutCount}箇所)を検出し、参考動画スタイル編集を追加しました
          </p>
        )}
        {!loading && referencePath && !referenceStyle && (
          <p className="hint-text autoedit-ai-note">
            参考動画からカットのテンポを検出できませんでした。別の動画を試してください。
          </p>
        )}
        {loading && <p className="hint-text">解析中... 素材のハイライトを検出しています</p>}
        {error && <p className="error-text">{error}</p>}
        {!loading && !error && patterns.length === 0 && (
          <p className="hint-text">編集パターンを生成できませんでした。</p>
        )}
        {!loading && patterns.length > 0 && (
          <div className="autoedit-grid">
            {patterns.map((p) => {
              const isDirector = p.style === 'director'
              const hasMixedTransitions = p.segments.some(
                (s) => s.transitionIn && s.transitionIn !== p.segments[1]?.transitionIn
              )
              return (
                <div
                  key={p.id}
                  className={`autoedit-card ${appliedId === p.id ? 'applied' : ''} ${recommendedId === p.id ? 'recommended' : ''} ${isDirector ? 'director' : ''}`}
                >
                  {isDirector ? (
                    <span className="autoedit-badge autoedit-badge-director">
                      <WandIcon width={11} height={11} />
                      AIディレクター
                    </span>
                  ) : (
                    recommendedId === p.id && (
                      <span className="autoedit-badge">
                        <SparklesIcon width={11} height={11} />
                        AIのおすすめ
                      </span>
                    )
                  )}
                  {thumbnails[p.id] ? (
                    <img src={thumbnails[p.id]} alt={p.label} className="autoedit-thumb" />
                  ) : (
                    <div className="autoedit-thumb autoedit-thumb-empty" />
                  )}
                  <div className="autoedit-card-body">
                    <p className="autoedit-card-title">{p.label}</p>
                    <p className="hint-text autoedit-card-desc">{p.description}</p>
                    <p className="hint-text autoedit-card-meta">
                      尺 {formatDuration(p.totalDuration)} / カット数 {p.segments.length} /{' '}
                      {isDirector && hasMixedTransitions
                        ? 'つなぎ方はカットごとにAIが選択'
                        : TRANSITION_LABELS[p.transition]}
                    </p>
                    <div className="autoedit-card-actions">
                      <button className="primary-button" onClick={() => handleApply(p)}>
                        <PlusIcon width={13} height={13} />
                        {appliedId === p.id ? '適用済み' : 'タイムラインに適用'}
                      </button>
                      <div className="autoedit-feedback">
                        <button
                          className={`icon-button ${feedback[p.id] === 'liked' ? 'active' : ''}`}
                          title="良い編集案"
                          onClick={() => handleFeedback(p, true)}
                        >
                          <ThumbsUpIcon width={13} height={13} />
                        </button>
                        <button
                          className={`icon-button ${feedback[p.id] === 'disliked' ? 'active' : ''}`}
                          title="好みではない"
                          onClick={() => handleFeedback(p, false)}
                        >
                          <ThumbsDownIcon width={13} height={13} />
                        </button>
                      </div>
                    </div>
                    <button
                      className="small-button autoedit-finish-button"
                      onClick={() => handleApplyAndFinish(p)}
                      disabled={finishingId === p.id}
                      title="タイムラインに適用した上で、字幕の自動文字起こしと投稿メタデータ生成まで一括で行います"
                    >
                      <MicIcon width={12} height={12} />
                      {finishingId === p.id
                        ? '字幕・メタデータを生成中...'
                        : '適用して自動で仕上げる'}
                    </button>
                    {appliedId === p.id && finishResult && (
                      <p className="hint-text autoedit-finish-result">
                        字幕を{finishResult.captionCount}件追加しました
                        {finishResult.metadata
                          ? '。メタデータも生成しました。「投稿準備」タブでご確認ください。'
                          : geminiApiKey
                            ? '。メタデータの生成に失敗しました。'
                            : '。メタデータも生成するにはGemini APIキーを設定してください。'}
                      </p>
                    )}
                    {appliedId === p.id && finishError && (
                      <p className="error-text">{finishError}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  )
}

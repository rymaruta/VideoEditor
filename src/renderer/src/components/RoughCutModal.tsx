import { playableOnMain } from '../lib/relinkCheck'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { formatIpcError } from '../lib/ipcError'
import { noHighlightsMessage } from '../lib/autoEdit'
import { TargetIcon, PlusIcon } from './icons'
import { useEscapeToClose } from '../lib/useEscapeToClose'

interface FlatCandidate {
  assetId: string
  assetName: string
  start: number
  end: number
  score: number
  hasSceneChange: boolean
  hasAudioPeak: boolean
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function autoSelect(candidates: FlatCandidate[], targetSeconds: number): Set<number> {
  const order = candidates
    .map((_, i) => i)
    .sort((a, b) => candidates[b].score - candidates[a].score)
  const chosen = new Set<number>()
  let total = 0
  for (const idx of order) {
    if (chosen.size > 0 && total >= targetSeconds) break
    chosen.add(idx)
    total += candidates[idx].end - candidates[idx].start
  }
  return chosen
}

export function RoughCutModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const addRoughCutClips = useProjectStore((s) => s.addRoughCutClips)
  const videoAssets = useMemo(() => project.assets.filter(playableOnMain), [project.assets])

  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<FlatCandidate[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [targetDuration, setTargetDuration] = useState(30)
  const [orderMode, setOrderMode] = useState<'source' | 'score'>('source')

  useEffect(() => {
    let cancelled = false
    async function run(): Promise<void> {
      setLoading(true)
      setError(null)
      setProgress(0)
      const all: FlatCandidate[] = []
      // 1本の失敗で全体を止めないが、**理由は捨てない**。捨てると壊れたファイルを
      // 渡しても「ハイライトを検出できませんでした」＝静かな動画と同じ表示になる
      // (理由と直し方は autoEdit の collectHighlights)。
      let failed = 0
      let firstFailure: string | null = null
      for (let i = 0; i < videoAssets.length; i++) {
        const asset = videoAssets[i]
        try {
          const found = await window.api.detectHighlights(asset.filePath, asset.duration)
          for (const c of found) {
            all.push({
              assetId: asset.id,
              assetName: asset.fileName,
              start: c.start,
              end: c.end,
              score: c.score,
              hasSceneChange: c.hasSceneChange,
              hasAudioPeak: c.hasAudioPeak
            })
          }
        } catch (e) {
          failed++
          if (firstFailure === null) firstFailure = formatIpcError(e)
        }
        if (cancelled) return
        setProgress(i + 1)
      }
      if (cancelled) return
      if (all.length === 0 && failed > 0) {
        setError(noHighlightsMessage(videoAssets.length, failed, firstFailure))
      }
      setCandidates(all)
      setSelected(autoSelect(all, targetDuration))
      setLoading(false)
    }
    run().catch((e) => {
      if (!cancelled) {
        setError(formatIpcError(e))
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggle(i: number): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  function handleAutoSelect(): void {
    setSelected(autoSelect(candidates, targetDuration))
  }

  const selectedDuration = candidates.reduce(
    (sum, c, i) => sum + (selected.has(i) ? c.end - c.start : 0),
    0
  )
  const maxScore = Math.max(1, ...candidates.map((c) => c.score))

  function handleApply(): void {
    const chosen = candidates.map((c, i) => ({ ...c, idx: i })).filter((c) => selected.has(c.idx))
    const ordered =
      orderMode === 'score'
        ? chosen.sort((a, b) => b.score - a.score)
        : chosen.sort((a, b) => {
            const orderA = videoAssets.findIndex((v) => v.id === a.assetId)
            const orderB = videoAssets.findIndex((v) => v.id === b.assetId)
            return orderA - orderB || a.start - b.start
          })
    addRoughCutClips(ordered.map((c) => ({ assetId: c.assetId, start: c.start, end: c.end })))
    onClose()
  }

  const backdropRef = useRef<HTMLDivElement>(null)
  useEscapeToClose(backdropRef, onClose)

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={onClose}>
      <div className="modal roughcut-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <TargetIcon width={15} height={15} />
          複数素材から自動ラフカット
        </h3>
        <p className="hint-text">
          メディア内のすべての動画素材からハイライトを検出し、目標の尺に収まるよう自動で候補を選びます。チェックを外したり付けたりして調整してから、タイムラインの末尾に追加できます。
        </p>
        {loading && (
          <p className="hint-text">
            解析中... ({progress}/{videoAssets.length} 素材)
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        {!loading && !error && candidates.length === 0 && (
          <p className="hint-text">ハイライトを検出できませんでした。</p>
        )}
        {!loading && candidates.length > 0 && (
          <>
            <div className="roughcut-controls">
              <label>
                目標の尺(秒)
                <input
                  type="number"
                  min={5}
                  max={300}
                  step={5}
                  value={targetDuration}
                  onChange={(e) => setTargetDuration(Number(e.target.value))}
                />
              </label>
              <button className="small-button" onClick={handleAutoSelect}>
                自動選択し直す
              </button>
              <label className="inline-select">
                並び順
                <select
                  value={orderMode}
                  onChange={(e) => setOrderMode(e.target.value as 'source' | 'score')}
                >
                  <option value="source">素材の順番</option>
                  <option value="score">スコア順(インパクト優先)</option>
                </select>
              </label>
            </div>
            <p className="hint-text roughcut-summary">
              選択中: {selected.size}件 / 合計 約{selectedDuration.toFixed(0)}秒(目標{' '}
              {targetDuration}秒)
            </p>
            <div className="highlight-list roughcut-list">
              {videoAssets.map((asset) => {
                const items = candidates
                  .map((c, i) => ({ ...c, idx: i }))
                  .filter((c) => c.assetId === asset.id)
                  .sort((a, b) => a.start - b.start)
                if (items.length === 0) return null
                return (
                  <div key={asset.id} className="roughcut-asset-group">
                    <p className="roughcut-asset-name">{asset.fileName}</p>
                    {items.map((c) => (
                      <div key={c.idx} className="highlight-item">
                        <input
                          type="checkbox"
                          checked={selected.has(c.idx)}
                          onChange={() => toggle(c.idx)}
                        />
                        <div className="highlight-item-info">
                          <span className="highlight-item-time">
                            {formatTime(c.start)} 〜 {formatTime(c.end)}
                          </span>
                          <div className="highlight-score-bar">
                            <div
                              className="highlight-score-fill"
                              style={{ width: `${(c.score / maxScore) * 100}%` }}
                            />
                          </div>
                          <span className="hint-text">
                            {c.hasSceneChange && 'カット '}
                            {c.hasAudioPeak && '音量変化'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>キャンセル</button>
          <button
            className="primary-button"
            onClick={handleApply}
            disabled={loading || selected.size === 0}
          >
            <PlusIcon width={13} height={13} />
            タイムラインに追加
          </button>
        </div>
      </div>
    </div>
  )
}

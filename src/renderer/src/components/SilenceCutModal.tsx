import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import type { Clip, SilenceRange } from '@shared/types'
import { buildCutSegments } from '../lib/silenceCut'
import { toTimelineSeconds } from '../lib/timelineMath'
import { formatIpcError } from '../lib/ipcError'
import { WandIcon } from './icons'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(1)
  return `${m}:${s.padStart(4, '0')}`
}

/** 1クリップぶんの検出結果。検出に失敗したものも `error` を持って並ぶ */
type ClipDetection = {
  clipId: string
  fileName: string
  /** 素材内の位置を画面ではクリップ先頭からの相対秒で出すため保持する */
  inPoint: number
  /** 表示をタイムラインの秒に直すための速度。検出結果は素材の秒で返ってくる */
  speed?: number
  ranges: SilenceRange[]
  error?: string
}

function rangeKey(clipId: string, index: number): string {
  return `${clipId}:${index}`
}

export function SilenceCutModal({
  clipIds,
  onClose
}: {
  clipIds: string[]
  onClose: () => void
}): React.JSX.Element {
  const replaceClipRanges = useProjectStore((s) => s.replaceClipRanges)

  const [detections, setDetections] = useState<ClipDetection[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [total, setTotal] = useState(0)
  const [running, setRunning] = useState(true)
  const [aborted, setAborted] = useState(false)
  // 中断は「次のクリップへ進まない」で実現する。実行中の ffmpeg は止められないので、
  // 押した直後に終わるとは限らない旨を画面にも書く。
  const abortRef = useRef(false)

  const key = clipIds.join(',')

  useEffect(() => {
    // 対象は開いた時点のプロジェクトから決める。検出中に置き換えが起きても
    // 走らせ直さない(開いている間に他の操作はできない)。
    const { project } = useProjectStore.getState()
    const targets = clipIds
      .map((id) => {
        const clip = project.clips.find((c) => c.id === id)
        const asset = clip ? project.assets.find((a) => a.id === clip.assetId) : undefined
        return clip && asset ? { clip, asset } : null
      })
      .filter((t): t is { clip: Clip; asset: (typeof project.assets)[number] } => t !== null)

    let disposed = false
    abortRef.current = false
    // Kicks off async IPC calls to the main process on mount — an external system
    // fetch, not state derivable from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTotal(targets.length)
    setDetections([])
    setChecked(new Set())
    setAborted(false)
    setRunning(targets.length > 0)
    ;(async () => {
      for (const { clip, asset } of targets) {
        if (disposed || abortRef.current) break
        let detection: ClipDetection
        try {
          const ranges = await window.api.detectSilence(asset.filePath, clip.inPoint, clip.outPoint)
          detection = {
            clipId: clip.id,
            fileName: asset.fileName,
            inPoint: clip.inPoint,
            speed: clip.speed,
            ranges
          }
        } catch (e) {
          // 1本失敗しても残りは検出して使えるようにする(まとめて掛けたときに
          // 1本の失敗で全部やり直しになると手間が本数分に戻る)。
          detection = {
            clipId: clip.id,
            fileName: asset.fileName,
            inPoint: clip.inPoint,
            speed: clip.speed,
            ranges: [],
            error: formatIpcError(e)
          }
        }
        if (disposed) return
        setDetections((prev) => [...prev, detection])
        setChecked((prev) => {
          const next = new Set(prev)
          detection.ranges.forEach((_, i) => next.add(rangeKey(detection.clipId, i)))
          return next
        })
      }
      if (!disposed) {
        setAborted(abortRef.current)
        setRunning(false)
      }
    })()
    return () => {
      disposed = true
      abortRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  function toggle(k: string): void {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  function handleApply(): void {
    const { project } = useProjectStore.getState()
    const replacements: { clipId: string; newClips: Clip[] }[] = []
    for (const d of detections) {
      const cutRanges = d.ranges.filter((_, i) => checked.has(rangeKey(d.clipId, i)))
      if (cutRanges.length === 0) continue
      const clip = project.clips.find((c) => c.id === d.clipId)
      if (!clip) continue
      replacements.push({ clipId: d.clipId, newClips: buildCutSegments(clip, cutRanges) })
    }
    // 何本掛けても履歴は1件(store 側でまとめて適用する)。
    replaceClipRanges(replacements)
    onClose()
  }

  const multi = clipIds.length > 1
  const checkedCount = checked.size
  const checkedSeconds = detections.reduce(
    (sum, d) =>
      sum +
      d.ranges.reduce(
        (s, r, i) =>
          checked.has(rangeKey(d.clipId, i)) ? s + toTimelineSeconds(r.end - r.start, d.speed) : s,
        0
      ),
    0
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <WandIcon width={15} height={15} />
          無音区間の検出
          {multi ? `: ${clipIds.length}個のクリップ` : `: ${detections[0]?.fileName ?? ''}`}
        </h3>
        {running && (
          <p className="hint-text detect-progress">
            検出中... ({detections.length}/{total})
            <button className="small-button" onClick={() => (abortRef.current = true)}>
              中断
            </button>
          </p>
        )}
        {aborted && (
          <p className="hint-text">
            中断しました({detections.length}/{total}
            件まで検出)。検出済みの分はそのまま適用できます。
          </p>
        )}
        {!running && total === 0 && <p className="hint-text">対象のクリップが見つかりません。</p>}
        {detections.length > 0 && (
          <div className="silence-range-list">
            {detections.map((d) => (
              <div key={d.clipId} className="silence-clip-group">
                {multi && (
                  <div className="silence-clip-name">
                    {d.fileName}
                    <span className="hint-text">
                      {formatTime(d.inPoint)}〜 / {d.ranges.length}件
                    </span>
                  </div>
                )}
                {d.error && <p className="error-text">{d.error}</p>}
                {!d.error && d.ranges.length === 0 && (
                  <p className="hint-text">無音区間は検出されませんでした。</p>
                )}
                {d.ranges.map((r, i) => (
                  <label key={i} className="silence-range-item">
                    <input
                      type="checkbox"
                      checked={checked.has(rangeKey(d.clipId, i))}
                      onChange={() => toggle(rangeKey(d.clipId, i))}
                    />
                    {formatTime(toTimelineSeconds(r.start - d.inPoint, d.speed))} 〜{' '}
                    {formatTime(toTimelineSeconds(r.end - d.inPoint, d.speed))}
                    <span className="hint-text">
                      ({toTimelineSeconds(r.end - r.start, d.speed).toFixed(1)}秒)
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
        <p className="hint-text">
          チェックした区間をクリップから削除します。誤検出があればチェックを外してください。
          {checkedCount > 0 && ` (${checkedCount}区間 / 合計${checkedSeconds.toFixed(1)}秒)`}
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>キャンセル</button>
          <button
            className="primary-button"
            onClick={handleApply}
            disabled={running || checkedCount === 0}
          >
            選択した区間を削除
          </button>
        </div>
      </div>
    </div>
  )
}

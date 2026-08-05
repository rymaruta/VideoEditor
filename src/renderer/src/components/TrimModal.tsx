import { useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { isAspectMismatch } from '../lib/aspect'
import { ScissorsIcon } from './icons'

function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withSlash)}`
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export function TrimModal({
  clipId,
  onClose
}: {
  clipId: string
  onClose: () => void
}): React.JSX.Element | null {
  const project = useProjectStore((s) => s.project)
  const updateClipTrim = useProjectStore((s) => s.updateClipTrim)
  const updateClipCrop = useProjectStore((s) => s.updateClipCrop)

  const clip = project.clips.find((c) => c.id === clipId)
  const asset = clip ? project.assets.find((a) => a.id === clip.assetId) : undefined

  const [inPoint, setInPoint] = useState(clip?.inPoint ?? 0)
  const [outPoint, setOutPoint] = useState(clip?.outPoint ?? asset?.duration ?? 0)
  // Crop settings are edited as a draft alongside the trim. They used to be
  // committed the moment the checkbox was ticked, so "キャンセル" left them
  // applied — and every toggle cost its own undo step.
  const [fillCrop, setFillCrop] = useState(clip?.fillCrop ?? false)
  const [cropCenter, setCropCenter] = useState(clip?.cropCenter)
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState<string | null>(null)

  if (!clip || !asset) return null

  function handleSave(): void {
    if (inPoint < outPoint) {
      updateClipTrim(clipId, inPoint, outPoint)
    }
    if (fillCrop !== (clip?.fillCrop ?? false) || cropCenter !== clip?.cropCenter) {
      updateClipCrop(clipId, fillCrop, cropCenter)
    }
    onClose()
  }

  const mismatch = isAspectMismatch(asset, project.aspectRatio)
  const targetAspect = project.aspectRatio === '9:16' ? 9 / 16 : 16 / 9

  async function handleDetectCrop(): Promise<void> {
    if (!clip || !asset) return
    setDetecting(true)
    setDetectError(null)
    try {
      const center = await window.api.analyzeSmartCrop(
        asset.filePath,
        inPoint,
        outPoint,
        asset.width,
        asset.height,
        targetAspect
      )
      setFillCrop(true)
      setCropCenter(center)
    } catch {
      setDetectError('被写体の自動検出に失敗しました')
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <ScissorsIcon width={15} height={15} />
          クリップをトリム: {asset.fileName}
        </h3>
        <video
          src={toFileUrl(asset.filePath)}
          controls
          className="trim-preview-video"
          onLoadedMetadata={(e) => {
            e.currentTarget.currentTime = inPoint
          }}
        />
        <div className="trim-field">
          <label>開始 (イン点): {formatTime(inPoint)}</label>
          <input
            type="range"
            min={0}
            max={asset.duration}
            step={0.1}
            value={inPoint}
            onChange={(e) => setInPoint(Math.min(Number(e.target.value), outPoint - 0.1))}
          />
        </div>
        <div className="trim-field">
          <label>終了 (アウト点): {formatTime(outPoint)}</label>
          <input
            type="range"
            min={0}
            max={asset.duration}
            step={0.1}
            value={outPoint}
            onChange={(e) => setOutPoint(Math.max(Number(e.target.value), inPoint + 0.1))}
          />
        </div>
        <div className="trim-summary">
          <span className="project-badge">選択範囲: {formatTime(outPoint - inPoint)}</span>
          <p className="hint-text">元動画の長さ: {formatTime(asset.duration)}</p>
        </div>
        {mismatch && (
          <div className="trim-field smart-crop-field">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={fillCrop}
                onChange={(e) => setFillCrop(e.target.checked)}
              />
              クロップして画面いっぱいに表示(黒帯なし)
            </label>
            <p className="hint-text">
              プロジェクトのアスペクト比と異なるため、有効にすると余白なしで表示されますが、映像の左右(または上下)が切り取られます。
            </p>
            {fillCrop && (
              <div className="overlay-item-row">
                <button onClick={handleDetectCrop} disabled={detecting}>
                  {detecting ? '被写体を検出中...' : '被写体を自動検出してクロップ位置を調整'}
                </button>
                <button
                  className="small-button"
                  onClick={() => setCropCenter({ x: 0.5, y: 0.5 })}
                  disabled={detecting}
                >
                  中央に戻す
                </button>
              </div>
            )}
            {detectError && <p className="error-text">{detectError}</p>}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>キャンセル</button>
          <button onClick={handleSave} className="primary-button">
            適用
          </button>
        </div>
      </div>
    </div>
  )
}

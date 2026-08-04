import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useProjectStore } from '../store/projectStore'
import { formatIpcError } from '../lib/ipcError'
import { isAspectMismatch } from '../lib/aspect'
import { HighlightModal } from './HighlightModal'
import { RoughCutModal } from './RoughCutModal'
import { AutoEditModal } from './AutoEditModal'
import {
  UploadIcon,
  PlusIcon,
  ClapperboardIcon,
  MusicIcon,
  AlertTriangleIcon,
  TargetIcon,
  WandIcon,
  RefreshIcon
} from './icons'

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export function MediaBin(): React.JSX.Element {
  const assets = useProjectStore((s) => s.project.assets)
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio)
  const audioTracks = useProjectStore((s) => s.project.audioTracks)
  const videoOverlayTracks = useProjectStore((s) => s.project.videoOverlayTracks)
  const addAsset = useProjectStore((s) => s.addAsset)
  const addClipToTimeline = useProjectStore((s) => s.addClipToTimeline)
  const addClipToAudioTrack = useProjectStore((s) => s.addClipToAudioTrack)
  const addClipToVideoOverlayTrack = useProjectStore((s) => s.addClipToVideoOverlayTrack)
  const missingAssetIds = useProjectStore((s) => s.missingAssetIds)
  const relinkAsset = useProjectStore((s) => s.relinkAsset)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trackChoice, setTrackChoice] = useState<Record<string, string>>({})
  const [videoTrackChoice, setVideoTrackChoice] = useState<Record<string, string>>({})
  const [highlightAssetId, setHighlightAssetId] = useState<string | null>(null)
  const [showRoughCut, setShowRoughCut] = useState(false)
  const [showAutoEdit, setShowAutoEdit] = useState(false)
  const [relinkingId, setRelinkingId] = useState<string | null>(null)
  const hasVideoAssets = assets.some((a) => a.hasVideo)

  async function handleRelink(assetId: string): Promise<void> {
    setError(null)
    setRelinkingId(assetId)
    try {
      const filePath = await window.api.selectRelinkFile()
      if (!filePath) return
      const meta = await window.api.probeMedia(filePath)
      let thumbnailDataUrl: string | undefined
      if (meta.hasVideo) {
        try {
          thumbnailDataUrl = await window.api.generateThumbnail(
            filePath,
            Math.min(1, meta.duration / 2)
          )
        } catch {
          thumbnailDataUrl = undefined
        }
      }
      relinkAsset(assetId, filePath, fileNameFromPath(filePath), meta, thumbnailDataUrl)
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setRelinkingId(null)
    }
  }

  async function importFiles(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    setImporting(true)
    try {
      for (const filePath of paths) {
        const meta = await window.api.probeMedia(filePath)
        let thumbnailDataUrl: string | undefined
        if (meta.hasVideo) {
          try {
            thumbnailDataUrl = await window.api.generateThumbnail(
              filePath,
              Math.min(1, meta.duration / 2)
            )
          } catch {
            thumbnailDataUrl = undefined
          }
        }
        addAsset({
          id: uuid(),
          filePath,
          fileName: fileNameFromPath(filePath),
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          fps: meta.fps,
          hasAudio: meta.hasAudio,
          hasVideo: meta.hasVideo,
          thumbnailDataUrl
        })
      }
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setImporting(false)
    }
  }

  async function handleImportVideo(): Promise<void> {
    setError(null)
    await importFiles(await window.api.selectMediaFiles())
  }

  async function handleImportAudio(): Promise<void> {
    setError(null)
    await importFiles(await window.api.selectAudioFiles())
  }

  return (
    <div className="panel media-bin">
      <div className="panel-header">
        <h2>メディア</h2>
        <div className="media-import-buttons">
          <button className="primary-button" onClick={handleImportVideo} disabled={importing}>
            <UploadIcon width={14} height={14} />
            動画
          </button>
          <button
            className="icon-button"
            onClick={handleImportAudio}
            disabled={importing}
            title="音楽/音声を追加"
          >
            <MusicIcon width={14} height={14} />
          </button>
        </div>
      </div>
      {hasVideoAssets && (
        <div className="media-bin-auto-buttons">
          <button
            className="small-button autoedit-trigger"
            onClick={() => setShowAutoEdit(true)}
            title="配置した動画素材から5種類の編集パターンをAIが自動生成します。良し悪しを評価すると次回以降の生成に反映されます"
          >
            <WandIcon width={13} height={13} />
            AIおまかせ全自動編集(5パターン)
          </button>
          <button
            className="small-button roughcut-trigger"
            onClick={() => setShowRoughCut(true)}
            title="すべての動画素材からハイライトを検出し、タイムラインへ自動でラフカットを組み立てます"
          >
            <WandIcon width={13} height={13} />
            複数素材から自動ラフカット
          </button>
        </div>
      )}
      {importing && <p className="hint-text">読み込み中...</p>}
      {error && <p className="error-text">{error}</p>}
      <div className="media-list">
        {assets.length === 0 && (
          <div className="empty-state">
            <ClapperboardIcon width={28} height={28} />
            <p className="hint-text">動画・音声ファイルを追加してください</p>
          </div>
        )}
        {assets.map((asset) => {
          const isMissing = missingAssetIds.includes(asset.id)
          return (
            <div key={asset.id} className={`media-item ${isMissing ? 'media-item-missing' : ''}`}>
              <div className="media-thumb">
                {asset.thumbnailDataUrl ? (
                  <img src={asset.thumbnailDataUrl} alt={asset.fileName} />
                ) : (
                  <div className="media-thumb-placeholder">
                    {asset.hasVideo ? (
                      <ClapperboardIcon width={16} height={16} />
                    ) : (
                      <MusicIcon width={16} height={16} />
                    )}
                  </div>
                )}
              </div>
              <div className="media-info">
                <div className="media-name" title={asset.fileName}>
                  {asset.fileName}
                </div>
                <div className="media-meta">
                  {formatDuration(asset.duration)}
                  {asset.hasVideo && ` ・ ${asset.width}x${asset.height}`}
                  {asset.hasVideo && !isMissing && isAspectMismatch(asset, aspectRatio) && (
                    <span
                      className="mismatch-badge"
                      title="プロジェクトのアスペクト比と異なるため、書き出し時に上下または左右に黒帯が入ります"
                    >
                      <AlertTriangleIcon width={11} height={11} />
                      比率が異なる
                    </span>
                  )}
                  {isMissing && (
                    <span
                      className="mismatch-badge missing-badge"
                      title={`ファイルが見つかりません: ${asset.filePath}`}
                    >
                      <AlertTriangleIcon width={11} height={11} />
                      ファイルが見つかりません
                    </span>
                  )}
                </div>
              </div>
              <div className="media-item-actions">
                {isMissing && (
                  <button
                    className="small-button"
                    onClick={() => handleRelink(asset.id)}
                    disabled={relinkingId === asset.id}
                    title="移動・改名されたファイルの場所を選び直します"
                  >
                    <RefreshIcon width={13} height={13} />
                    再リンク
                  </button>
                )}
                {!isMissing && asset.hasVideo && (
                  <button
                    className="icon-button"
                    onClick={() => setHighlightAssetId(asset.id)}
                    title="ハイライトを検出"
                  >
                    <TargetIcon width={14} height={14} />
                  </button>
                )}
                {!isMissing && asset.hasVideo && (
                  <button
                    className="icon-button"
                    onClick={() => addClipToTimeline(asset.id)}
                    title="動画トラックに追加"
                  >
                    <PlusIcon width={14} height={14} />
                  </button>
                )}
                {!isMissing && asset.hasAudio && audioTracks.length > 0 && (
                  <div className="media-track-add">
                    <select
                      value={trackChoice[asset.id] ?? audioTracks[0].id}
                      onChange={(e) =>
                        setTrackChoice((prev) => ({ ...prev, [asset.id]: e.target.value }))
                      }
                    >
                      {audioTracks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="icon-button"
                      title="音声トラックに追加"
                      onClick={() =>
                        addClipToAudioTrack(trackChoice[asset.id] ?? audioTracks[0].id, asset.id)
                      }
                    >
                      <PlusIcon width={14} height={14} />
                    </button>
                  </div>
                )}
                {!isMissing && asset.hasVideo && videoOverlayTracks.length > 0 && (
                  <div className="media-track-add">
                    <select
                      value={videoTrackChoice[asset.id] ?? videoOverlayTracks[0].id}
                      onChange={(e) =>
                        setVideoTrackChoice((prev) => ({ ...prev, [asset.id]: e.target.value }))
                      }
                    >
                      {videoOverlayTracks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="icon-button"
                      title="動画トラック(PiP)に追加"
                      onClick={() =>
                        addClipToVideoOverlayTrack(
                          videoTrackChoice[asset.id] ?? videoOverlayTracks[0].id,
                          asset.id
                        )
                      }
                    >
                      <PlusIcon width={14} height={14} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {highlightAssetId && (
        <HighlightModal assetId={highlightAssetId} onClose={() => setHighlightAssetId(null)} />
      )}
      {showRoughCut && <RoughCutModal onClose={() => setShowRoughCut(false)} />}
      {showAutoEdit && <AutoEditModal onClose={() => setShowAutoEdit(false)} />}
    </div>
  )
}

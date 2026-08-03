import { useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useProjectStore } from '../store/projectStore'
import { UploadIcon, PlusIcon, ClapperboardIcon } from './icons'

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
  const addAsset = useProjectStore((s) => s.addAsset)
  const addClipToTimeline = useProjectStore((s) => s.addClipToTimeline)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleImport(): Promise<void> {
    setError(null)
    const paths = await window.api.selectMediaFiles()
    if (paths.length === 0) return
    setImporting(true)
    try {
      for (const filePath of paths) {
        const meta = await window.api.probeMedia(filePath)
        let thumbnailDataUrl: string | undefined
        try {
          thumbnailDataUrl = await window.api.generateThumbnail(
            filePath,
            Math.min(1, meta.duration / 2)
          )
        } catch {
          thumbnailDataUrl = undefined
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
          thumbnailDataUrl
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="panel media-bin">
      <div className="panel-header">
        <h2>メディア</h2>
        <button className="primary-button" onClick={handleImport} disabled={importing}>
          <UploadIcon width={14} height={14} />
          {importing ? '読み込み中...' : '動画を追加'}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="media-list">
        {assets.length === 0 && (
          <div className="empty-state">
            <ClapperboardIcon width={28} height={28} />
            <p className="hint-text">動画ファイルを追加してください</p>
          </div>
        )}
        {assets.map((asset) => (
          <div key={asset.id} className="media-item">
            <div className="media-thumb">
              {asset.thumbnailDataUrl ? (
                <img src={asset.thumbnailDataUrl} alt={asset.fileName} />
              ) : (
                <div className="media-thumb-placeholder" />
              )}
            </div>
            <div className="media-info">
              <div className="media-name" title={asset.fileName}>
                {asset.fileName}
              </div>
              <div className="media-meta">
                {formatDuration(asset.duration)} ・ {asset.width}x{asset.height}
              </div>
            </div>
            <button
              className="icon-button"
              onClick={() => addClipToTimeline(asset.id)}
              title="タイムラインに追加"
            >
              <PlusIcon width={14} height={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { DownloadIcon } from './icons'
import { formatIpcError } from '../lib/ipcError'
import type { QualityPreset, ResolutionHeight } from '@shared/types'

export function ExportPanel(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio)
  const [resolutionHeight, setResolutionHeight] = useState<ResolutionHeight>(1080)
  const [quality, setQuality] = useState<QualityPreset>('standard')
  const [progress, setProgress] = useState<{ percent: number; stage: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneMessage, setDoneMessage] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = window.api.onExportProgress((p) => setProgress(p))
    return unsubscribe
  }, [])

  async function handleExport(): Promise<void> {
    setError(null)
    setDoneMessage(null)
    if (project.clips.length === 0) {
      setError('タイムラインにクリップがありません')
      return
    }
    const outputPath = await window.api.selectExportPath(`${project.name}.mp4`)
    if (!outputPath) return
    setExporting(true)
    setProgress({ percent: 0, stage: '準備中' })
    try {
      await window.api.exportProject({
        project,
        aspectRatio: project.aspectRatio,
        resolutionHeight,
        quality,
        outputPath
      })
      setDoneMessage(`書き出しが完了しました: ${outputPath}`)
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="panel export-panel">
      <div className="panel-header">
        <h2>書き出し</h2>
      </div>
      <div className="export-field">
        <label>アスペクト比</label>
        <div className="aspect-toggle">
          <button
            type="button"
            className={project.aspectRatio === '9:16' ? 'active' : ''}
            onClick={() => setAspectRatio('9:16')}
          >
            <span className="aspect-swatch aspect-swatch-9-16" />
            9:16(ショート)
          </button>
          <button
            type="button"
            className={project.aspectRatio === '16:9' ? 'active' : ''}
            onClick={() => setAspectRatio('16:9')}
          >
            <span className="aspect-swatch aspect-swatch-16-9" />
            16:9(横型)
          </button>
        </div>
      </div>
      <div className="export-field">
        <label>解像度</label>
        <select
          value={resolutionHeight}
          onChange={(e) => setResolutionHeight(Number(e.target.value) as ResolutionHeight)}
        >
          <option value={1440}>2K (1440)</option>
          <option value={1080}>フルHD (1080)</option>
          <option value={720}>HD (720)</option>
          <option value={480}>SD (480・軽量)</option>
        </select>
      </div>
      <div className="export-field">
        <label>画質(圧縮率)</label>
        <select value={quality} onChange={(e) => setQuality(e.target.value as QualityPreset)}>
          <option value="high">高画質(ファイルサイズ大)</option>
          <option value="standard">標準</option>
          <option value="small">軽量(ファイルサイズ小)</option>
        </select>
      </div>
      <button className="primary-button export-button" onClick={handleExport} disabled={exporting}>
        <DownloadIcon width={15} height={15} />
        {exporting ? '書き出し中...' : '動画を書き出す'}
      </button>
      {progress && exporting && (
        <div className="progress-bar">
          <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
          <span>
            {progress.stage} {Math.round(progress.percent)}%
          </span>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      {doneMessage && <p className="success-text">{doneMessage}</p>}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useProjectStore } from '../store/projectStore'
import { DownloadIcon, FolderIcon, PlayCircleIcon, PlusIcon, TrashIcon, LayersIcon } from './icons'
import { formatIpcError } from '../lib/ipcError'
import type { AspectRatio, QualityPreset, ResolutionHeight } from '@shared/types'

interface BatchJob {
  id: string
  aspectRatio: AspectRatio
  resolutionHeight: ResolutionHeight
  quality: QualityPreset
}

type JobStatus = 'pending' | 'running' | 'done' | 'error'

function qualityLabel(q: QualityPreset): string {
  switch (q) {
    case 'high':
      return '高画質'
    case 'small':
      return '軽量'
    default:
      return '標準'
  }
}

function jobFileName(projectName: string, job: BatchJob): string {
  const aspect = job.aspectRatio === '9:16' ? '9x16' : '16x9'
  return `${projectName}_${aspect}_${job.resolutionHeight}p.mp4`
}

function usedMissingAssetCount(
  project: ReturnType<typeof useProjectStore.getState>['project'],
  missingAssetIds: string[]
): number {
  if (missingAssetIds.length === 0) return 0
  const missingSet = new Set(missingAssetIds)
  const usedIds = new Set<string>()
  project.clips.forEach((c) => usedIds.add(c.assetId))
  project.audioTracks.forEach((t) => t.clips.forEach((c) => usedIds.add(c.assetId)))
  project.videoOverlayTracks.forEach((t) => t.clips.forEach((c) => usedIds.add(c.assetId)))
  let count = 0
  usedIds.forEach((id) => {
    if (missingSet.has(id)) count++
  })
  return count
}

export function ExportPanel(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const missingAssetIds = useProjectStore((s) => s.missingAssetIds)
  const setAspectRatio = useProjectStore((s) => s.setAspectRatio)
  const [resolutionHeight, setResolutionHeight] = useState<ResolutionHeight>(1080)
  const [quality, setQuality] = useState<QualityPreset>('standard')
  const [loudnessNormalization, setLoudnessNormalization] = useState(true)
  const [progress, setProgress] = useState<{ percent: number; stage: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [doneMessage, setDoneMessage] = useState<string | null>(null)
  const [doneFilePath, setDoneFilePath] = useState<string | null>(null)

  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([])
  const [batchStatus, setBatchStatus] = useState<Record<string, JobStatus>>({})
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [batchFolder, setBatchFolder] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = window.api.onExportProgress((p) => setProgress(p))
    return unsubscribe
  }, [])

  async function handleExport(): Promise<void> {
    setError(null)
    setDoneMessage(null)
    setDoneFilePath(null)
    if (project.clips.length === 0) {
      setError('タイムラインにクリップがありません')
      return
    }
    if (usedMissingAssetCount(project, missingAssetIds) > 0) {
      setError(
        '見つからない素材ファイルがタイムラインで使用されています。メディアパネルで再リンクしてから書き出してください。'
      )
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
        outputPath,
        loudnessNormalization
      })
      setDoneMessage(`書き出しが完了しました: ${outputPath}`)
      setDoneFilePath(outputPath)
    } catch (e) {
      const message = formatIpcError(e)
      if (message !== 'EXPORT_CANCELED') setError(message)
    } finally {
      setExporting(false)
      setProgress(null)
    }
  }

  async function handleCancelExport(): Promise<void> {
    await window.api.cancelExport()
  }

  function addBatchJob(aspectRatio: AspectRatio, height: ResolutionHeight, q: QualityPreset): void {
    setBatchJobs((prev) => [
      ...prev,
      { id: uuid(), aspectRatio, resolutionHeight: height, quality: q }
    ])
  }

  function removeBatchJob(id: string): void {
    setBatchJobs((prev) => prev.filter((j) => j.id !== id))
  }

  async function handleBatchExport(): Promise<void> {
    setBatchError(null)
    if (project.clips.length === 0) {
      setBatchError('タイムラインにクリップがありません')
      return
    }
    if (batchJobs.length === 0) {
      setBatchError('書き出す組み合わせを追加してください')
      return
    }
    if (usedMissingAssetCount(project, missingAssetIds) > 0) {
      setBatchError(
        '見つからない素材ファイルがタイムラインで使用されています。メディアパネルで再リンクしてから書き出してください。'
      )
      return
    }
    const folder = await window.api.selectExportFolder()
    if (!folder) return
    setBatchFolder(folder)
    setBatchRunning(true)
    const nextStatus: Record<string, JobStatus> = {}
    batchJobs.forEach((j) => (nextStatus[j.id] = 'pending'))
    setBatchStatus(nextStatus)
    for (const job of batchJobs) {
      setBatchStatus((prev) => ({ ...prev, [job.id]: 'running' }))
      setProgress({ percent: 0, stage: '準備中' })
      try {
        const outputPath = `${folder}/${jobFileName(project.name, job)}`
        await window.api.exportProject({
          project,
          aspectRatio: job.aspectRatio,
          resolutionHeight: job.resolutionHeight,
          quality: job.quality,
          outputPath,
          loudnessNormalization
        })
        setBatchStatus((prev) => ({ ...prev, [job.id]: 'done' }))
      } catch (e) {
        const message = formatIpcError(e)
        setBatchStatus((prev) => ({
          ...prev,
          [job.id]: message === 'EXPORT_CANCELED' ? 'pending' : 'error'
        }))
        if (message === 'EXPORT_CANCELED') {
          setBatchRunning(false)
          setProgress(null)
          return
        }
        setBatchError(message)
      }
    }
    setBatchRunning(false)
    setProgress(null)
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
      <div className="export-field">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={loudnessNormalization}
            onChange={(e) => setLoudnessNormalization(e.target.checked)}
          />
          ラウドネス正規化(音量を自動調整)
        </label>
        <p className="hint-text">
          元動画・BGM・ナレーションの音量差を書き出し時に自動で揃えます(YouTube推奨値に合わせています)。
        </p>
      </div>
      <div className="export-button-row">
        <button
          className="primary-button export-button"
          onClick={handleExport}
          disabled={exporting}
        >
          <DownloadIcon width={15} height={15} />
          {exporting ? '書き出し中...' : '動画を書き出す'}
        </button>
        {(exporting || batchRunning) && (
          <button className="small-button danger" onClick={handleCancelExport}>
            キャンセル
          </button>
        )}
      </div>
      {progress && (exporting || batchRunning) && (
        <div className="progress-bar">
          <div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} />
          <span>
            {progress.stage} {Math.round(progress.percent)}%
          </span>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      {doneMessage && (
        <div className="export-done">
          <p className="success-text">{doneMessage}</p>
          <div className="export-done-actions">
            <button
              className="small-button"
              onClick={() => doneFilePath && window.api.openPath(doneFilePath)}
            >
              <PlayCircleIcon width={13} height={13} />
              再生
            </button>
            <button
              className="small-button"
              onClick={() => doneFilePath && window.api.showItemInFolder(doneFilePath)}
            >
              <FolderIcon width={13} height={13} />
              フォルダを表示
            </button>
          </div>
        </div>
      )}

      <div className="export-field batch-export-section">
        <label>
          <LayersIcon width={13} height={13} />
          バッチ書き出し(複数の組み合わせをまとめて生成)
        </label>
        <div className="batch-quick-add">
          <button
            className="small-button"
            onClick={() => addBatchJob('9:16', 1080, 'standard')}
            disabled={batchRunning}
          >
            9:16 / 1080p
          </button>
          <button
            className="small-button"
            onClick={() => addBatchJob('16:9', 1080, 'standard')}
            disabled={batchRunning}
          >
            16:9 / 1080p
          </button>
          <button
            className="small-button"
            onClick={() => addBatchJob('9:16', 720, 'small')}
            disabled={batchRunning}
          >
            9:16 / 720p(軽量)
          </button>
        </div>
        {batchJobs.length > 0 && (
          <ul className="batch-job-list">
            {batchJobs.map((job) => (
              <li
                key={job.id}
                className={`batch-job-item batch-job-${batchStatus[job.id] ?? 'pending'}`}
              >
                <span>
                  {job.aspectRatio} ・ {job.resolutionHeight}p ・ {qualityLabel(job.quality)}
                </span>
                {batchStatus[job.id] === 'done' && <span className="batch-job-badge">完了</span>}
                {batchStatus[job.id] === 'running' && (
                  <span className="batch-job-badge">実行中</span>
                )}
                {batchStatus[job.id] === 'error' && <span className="batch-job-badge">失敗</span>}
                <button
                  className="icon-button danger"
                  title="削除"
                  disabled={batchRunning}
                  onClick={() => removeBatchJob(job.id)}
                >
                  <TrashIcon width={12} height={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          className="primary-button"
          onClick={handleBatchExport}
          disabled={batchRunning || batchJobs.length === 0}
        >
          <PlusIcon width={13} height={13} />
          {batchRunning ? '一括書き出し中...' : '一括書き出し'}
        </button>
        {batchFolder && !batchRunning && !batchError && (
          <p className="hint-text">出力先: {batchFolder}</p>
        )}
        {batchError && <p className="error-text">{batchError}</p>}
      </div>
    </div>
  )
}

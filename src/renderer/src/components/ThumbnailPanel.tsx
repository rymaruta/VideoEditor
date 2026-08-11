import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { buildTimedClips, totalTimelineDuration, findTimedClipAt } from '../lib/timelineMath'
import { formatIpcError } from '../lib/ipcError'
import { ImageIcon, DownloadIcon, SparklesIcon, WandIcon } from './icons'
import { targetResolution } from '@shared/resolution'
import type { TextPosition } from '@shared/types'

// サムネイルの短辺。長辺はプロジェクトのアスペクト比から targetResolution() が決める
// (9:16 なら 720x1280、16:9 なら 1280x720)。書き出しと同じ関数を使う。
const THUMB_SHORT_SIDE = 720
const CANDIDATE_COUNT = 6

interface ThumbStyle {
  fontSize: number
  color: string
  position: TextPosition
  bold: boolean
  outline: boolean
}

export function ThumbnailPanel(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const [candidates, setCandidates] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [style, setStyle] = useState<ThumbStyle>({
    fontSize: 90,
    color: '#ffffff',
    position: 'bottom',
    bold: true,
    outline: true
  })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { w: thumbWidth, h: thumbHeight } = targetResolution(project.aspectRatio, THUMB_SHORT_SIDE)

  async function generateCandidates(): Promise<void> {
    setError(null)
    const timedClips = buildTimedClips(project)
    const total = totalTimelineDuration(timedClips)
    if (timedClips.length === 0 || total <= 0) {
      setError('タイムラインにクリップを追加してください')
      return
    }
    setLoading(true)
    setCandidates([])
    try {
      const times = Array.from(
        { length: CANDIDATE_COUNT },
        (_, i) => (total * (i + 0.5)) / CANDIDATE_COUNT
      )
      const frames: string[] = []
      for (const t of times) {
        const tc = findTimedClipAt(timedClips, t)
        if (!tc) continue
        const speed = tc.clip.speed || 1
        const localTime = tc.clip.inPoint + (t - tc.start) * speed
        // 書き出しと同じ画角にするため、そのクリップのクロップ設定をそのまま渡す
        const dataUrl = await window.api.generateFrame(
          tc.asset.filePath,
          localTime,
          thumbWidth,
          thumbHeight,
          tc.clip.fillCrop,
          tc.clip.cropCenter
        )
        frames.push(dataUrl)
      }
      setCandidates(frames)
      setSelected(frames[0] ?? null)
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setLoading(false)
    }
  }

  async function generateHighlightCandidates(): Promise<void> {
    setError(null)
    const timedClips = buildTimedClips(project)
    if (timedClips.length === 0) {
      setError('タイムラインにクリップを追加してください')
      return
    }
    setLoading(true)
    setCandidates([])
    try {
      const assetIds = Array.from(new Set(timedClips.map((tc) => tc.asset.id)))
      const scored: {
        assetId: string
        time: number
        score: number
        fillCrop?: boolean
        cropCenter?: { x: number; y: number }
      }[] = []
      for (const assetId of assetIds) {
        const asset = project.assets.find((a) => a.id === assetId)
        if (!asset || !asset.hasVideo) continue
        const clipsForAsset = timedClips.filter((tc) => tc.asset.id === assetId)
        try {
          const highlights = await window.api.detectHighlights(asset.filePath, asset.duration)
          for (const h of highlights) {
            const mid = (h.start + h.end) / 2
            const containing = clipsForAsset.find(
              (tc) => mid >= tc.clip.inPoint && mid <= tc.clip.outPoint
            )
            if (containing) {
              scored.push({
                assetId,
                time: mid,
                score: h.score,
                fillCrop: containing.clip.fillCrop,
                cropCenter: containing.clip.cropCenter
              })
            }
          }
        } catch {
          // Skip assets whose highlight analysis fails; continue with the rest.
        }
      }
      scored.sort((a, b) => b.score - a.score)
      const top = scored.slice(0, CANDIDATE_COUNT)
      if (top.length === 0) {
        setError('ハイライトが見つかりませんでした。「均等間隔で生成」をお試しください。')
        return
      }
      const frames: string[] = []
      for (const entry of top) {
        const asset = project.assets.find((a) => a.id === entry.assetId)
        if (!asset) continue
        const dataUrl = await window.api.generateFrame(
          asset.filePath,
          entry.time,
          thumbWidth,
          thumbHeight,
          entry.fillCrop,
          entry.cropCenter
        )
        frames.push(dataUrl)
      }
      setCandidates(frames)
      setSelected(frames[0] ?? null)
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!selected) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = new Image()
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      if (text.trim()) {
        const y =
          style.position === 'top'
            ? canvas.height * 0.16
            : style.position === 'bottom'
              ? canvas.height * 0.84
              : canvas.height / 2
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.font = `${style.bold ? '700' : '400'} ${style.fontSize}px sans-serif`
        if (style.outline) {
          ctx.lineWidth = style.fontSize * 0.14
          ctx.strokeStyle = '#000000'
          ctx.lineJoin = 'round'
          ctx.strokeText(text, canvas.width / 2, y)
        }
        ctx.fillStyle = style.color
        ctx.fillText(text, canvas.width / 2, y)
      }
    }
    img.src = selected
  }, [selected, text, style])

  function handleDownload(): void {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = `${project.name || 'thumbnail'}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  return (
    <div className="panel thumbnail-panel">
      <div className="panel-header">
        <h2>サムネイル生成</h2>
      </div>
      <div className="thumbnail-generate-buttons">
        <button className="primary-button" onClick={generateCandidates} disabled={loading}>
          <SparklesIcon width={14} height={14} />
          {loading ? '生成中...' : '均等間隔で生成'}
        </button>
        <button className="small-button" onClick={generateHighlightCandidates} disabled={loading}>
          <WandIcon width={13} height={13} />
          ハイライトから生成
        </button>
      </div>
      <p className="hint-text">
        「均等間隔で生成」はタイムラインを一定間隔で抽出、「ハイライトから生成」はAIが検出した音量変化やカット点などの見せ場からフレームを抽出してサムネイルの候補にします。プロジェクトのアスペクト比に合わせて、9:16なら720x1280(縦)、16:9なら1280x720で作ります。
      </p>
      {error && <p className="error-text">{error}</p>}
      {candidates.length === 0 && !loading && (
        <div className="empty-state">
          <ImageIcon width={26} height={26} />
          <p className="hint-text">上のボタンから候補を生成してください</p>
        </div>
      )}
      {candidates.length > 0 && (
        <>
          <div className="thumbnail-candidates">
            {candidates.map((c, i) => (
              <img
                key={i}
                src={c}
                className={`thumbnail-candidate ${selected === c ? 'selected' : ''}`}
                onClick={() => setSelected(c)}
                alt={`候補${i + 1}`}
              />
            ))}
          </div>
          <canvas
            ref={canvasRef}
            width={thumbWidth}
            height={thumbHeight}
            className="thumbnail-canvas"
          />
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="サムネイルのテキスト"
            className="thumbnail-text-input"
          />
          <div className="overlay-item-row">
            <label>
              サイズ
              <input
                type="number"
                min={30}
                max={160}
                value={style.fontSize}
                onChange={(e) => setStyle((s) => ({ ...s, fontSize: Number(e.target.value) }))}
              />
            </label>
            <label>
              色
              <input
                type="color"
                value={style.color}
                onChange={(e) => setStyle((s) => ({ ...s, color: e.target.value }))}
              />
            </label>
            <label>
              位置
              <select
                value={style.position}
                onChange={(e) =>
                  setStyle((s) => ({ ...s, position: e.target.value as TextPosition }))
                }
              >
                <option value="top">上</option>
                <option value="center">中央</option>
                <option value="bottom">下</option>
              </select>
            </label>
          </div>
          <button className="primary-button thumbnail-download" onClick={handleDownload}>
            <DownloadIcon width={14} height={14} />
            PNGでダウンロード
          </button>
        </>
      )}
    </div>
  )
}

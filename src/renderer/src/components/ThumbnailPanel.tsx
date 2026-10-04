import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { buildTimedClips, totalTimelineDuration, findTimedClipAt } from '../lib/timelineMath'
import { formatIpcError } from '../lib/ipcError'
import { ImageIcon, DownloadIcon, SparklesIcon, WandIcon } from './icons'
import { targetResolution } from '@shared/resolution'
import { safeFileBaseName } from '@shared/fileName'
import { ColorField } from './ColorField'
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
  const projectId = useProjectStore((s) => s.project.id)
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
  // 表示枠も同じ寸法から決める。CSS 側に 16/9 を書くと、9:16 プロジェクトでは
  // 720x1280 の絵を 16:9 の枠に押し込んで表示することになり、**保存される画像は
  // 正しいのに編集中の画面だけが歪む**(実測で横方向に3.16倍)。候補一覧も
  // object-fit: cover で中央の帯しか出ず、候補を見分けられなくなる。
  const thumbAspect = { aspectRatio: `${thumbWidth} / ${thumbHeight}` }

  /**
   * 別のプロジェクトを開いた/新規作成したら、前の動画から抜いた候補を捨てる。
   *
   * この画面はタブを切り替えてもマウントされたままなので、明示的に捨てないと
   * **別の動画の画面に前の動画のサムネ候補が並び、そのまま書き出せてしまう**
   * (実測: Aで6件作ったあとBを開いても6件のまま残っていた)。
   * 文字・スタイルは利用者が決めた値なので残す(結果だけ捨てる)。
   */
  useEffect(() => {
    // 外部から取ってきた結果を捨てる副作用。props から導ける値ではない。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCandidates([])
    setSelected(null)
    setError(null)
  }, [projectId])

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
          tc.clip.cropCenter,
          tc.clip.blurBackground
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
        blurBackground?: boolean
      }[] = []
      let failed = 0
      let firstFailure: string | null = null
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
                cropCenter: containing.clip.cropCenter,
                blurBackground: containing.clip.blurBackground
              })
            }
          }
        } catch (e) {
          // 1本の失敗で全体は止めないが、**理由は捨てない**(理由は autoEdit の
          // collectHighlights)。捨てると壊れたファイルでも「見つかりませんでした」
          // ＝ハイライトの無い動画と同じ表示になる。
          failed++
          if (firstFailure === null) firstFailure = formatIpcError(e)
        }
      }
      scored.sort((a, b) => b.score - a.score)
      const top = scored.slice(0, CANDIDATE_COUNT)
      if (top.length === 0) {
        setError(
          failed > 0 && firstFailure
            ? `ハイライトが見つかりませんでした(${failed}件の解析に失敗しました: ${firstFailure})。「均等間隔で生成」をお試しください。`
            : 'ハイライトが見つかりませんでした。「均等間隔で生成」をお試しください。'
        )
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
          entry.cropCenter,
          entry.blurBackground
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
    link.download = `${safeFileBaseName(project.name)}.png`
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
                style={thumbAspect}
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
            style={thumbAspect}
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
            {/* label で包むと、色の吹き出しの中を押すたびに見本のボタンが押され直して閉じる */}
            <div className="overlay-item-field">
              色
              <ColorField
                label="サムネイルの文字の色"
                value={style.color}
                onChange={(hex) => setStyle((s) => ({ ...s, color: hex }))}
              />
            </div>
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

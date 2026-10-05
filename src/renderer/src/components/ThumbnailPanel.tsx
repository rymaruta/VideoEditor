import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { usePresetStore } from '../store/presetStore'
import { buildTimedClips, totalTimelineDuration, findTimedClipAt } from '../lib/timelineMath'
import { formatIpcError } from '../lib/ipcError'
import { ImageIcon, DownloadIcon, SparklesIcon, WandIcon } from './icons'
import { targetResolution } from '@shared/resolution'
import { safeFileBaseName } from '@shared/fileName'
import { textCanvasSize } from '@shared/resolution'
import { drawTelop, layoutTelop, type TelopContext } from '@shared/telop/render'
import type { TextPosition, TextStyle } from '@shared/types'
import { loadTelopFonts } from '../lib/telopFonts'
import {
  lookPatch,
  scaleLook,
  SECTION_IDS,
  settledTelopTime,
  stillTelopStyle
} from '../lib/appearanceEdit'
import { useStyleClipboard } from '../lib/styleClipboard'
import {
  defaultThumbnailStyle,
  readThumbnailStyle,
  readThumbnailText,
  writeThumbnailStyle,
  writeThumbnailText
} from '../lib/thumbnailStyle'
import { NumberSlider } from './AppearanceControls'
import { PropRow, TelopStyleFields } from './TelopStyleFields'
import { TelopLookPicker, type LookItem } from './TelopLookGallery'
import { paintBackdrop } from '../lib/lookThumb'

// サムネイルの短辺。長辺はプロジェクトのアスペクト比から targetResolution() が決める
// (9:16 なら 720x1280、16:9 なら 1280x720)。書き出しと同じ関数を使う。
const THUMB_SHORT_SIDE = 720
const CANDIDATE_COUNT = 6

/**
 * サムネイルの文字は、テロップと同じ見た目(TextStyle)と同じ描き方(drawTelop)で描く。
 * 書体・グラデーション・何重もの縁・背景・影・光彩・部分の装飾(**強調**)・ルビ・縦書き・
 * マイ設定・見た目の一覧が、テロップと同じ欄でそのまま使える。動きは止め絵なので、
 * 登場の動きが終わってから消える動きが始まる前の姿を描く。
 */
export function ThumbnailPanel(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const projectId = useProjectStore((s) => s.project.id)
  const [candidates, setCandidates] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [text, setTextState] = useState(() => readThumbnailText(projectId))
  const [style, setStyleState] = useState<TextStyle>(readThumbnailStyle)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [fontEpoch, setFontEpoch] = useState(0)
  const captionPresets = usePresetStore((s) => s.captionPresets)
  const clipStyle = useStyleClipboard((s) => s.style)
  const clipFrom = useStyleClipboard((s) => s.from)
  const copyLook = useStyleClipboard((s) => s.copy)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const textCanvas = useMemo(() => textCanvasSize(project.aspectRatio), [project.aspectRatio])
  const setText = (t: string): void => {
    setTextState(t)
    writeThumbnailText(projectId, t)
  }
  const setStyle = (next: TextStyle): void => {
    setStyleState(next)
    writeThumbnailStyle(next)
  }
  const patch = (p: Partial<TextStyle>): void => setStyle({ ...style, ...p })
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
    setTextState(readThumbnailText(projectId))
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

  // 選んだ候補の画を読み込む(描くたびに読み直すと、文字を打つたびにちらつく)
  useEffect(() => {
    if (!selected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setImage(null)
      return
    }
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (alive) setImage(img)
    }
    img.src = selected
    return () => {
      alive = false
    }
  }, [selected])

  // 同梱フォントは使うまで読み込まれないので、使う書体と文字を先に読み込んでから描き直す
  useEffect(() => {
    let alive = true
    void loadTelopFonts([{ text, style }]).then((changed) => {
      if (alive && changed) setFontEpoch((e) => e + 1)
    })
    return () => {
      alive = false
    }
  }, [text, style])

  // 書き出しと同じ解像度(サムネイルの実寸)で描く
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const { width: w, height: h } = canvas
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (image) ctx.drawImage(image, 0, 0, w, h)
    else paintBackdrop(ctx, w, h)
    if (!text.trim()) return
    const still = stillTelopStyle(style)
    const { time, endTime } = settledTelopTime(still, text)
    drawTelop(
      ctx as unknown as TelopContext,
      { text, startTime: 0, endTime, style: still },
      time,
      { width: w, height: h },
      textCanvas
    )
  }, [image, text, style, fontEpoch, textCanvas, thumbWidth, thumbHeight])

  /** 文字の塊の中心(画面に対する割合)。自由配置ならその点、そうでなければ今の置き場所から測る */
  function blockCenter(): { x: number; y: number } {
    if (style.customPosition) return style.customPosition
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx || !text.trim()) return { x: 0.5, y: 0.5 }
    const layout = layoutTelop(
      ctx as unknown as TelopContext,
      { text, startTime: 0, endTime: 1, style },
      textCanvas
    )
    return {
      x: layout.anchor.x / textCanvas.w,
      y: (layout.anchor.y + layout.topFromAnchor + layout.blockHeight / 2) / textCanvas.h
    }
  }

  // 見本の上で文字をドラッグして動かす(Canva と同じ)。動かすと自由配置になる
  function onCanvasPointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!text.trim() || e.button !== 0) return
    const r = e.currentTarget.getBoundingClientRect()
    const c = blockCenter()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { px: (e.clientX - r.left) / r.width, py: (e.clientY - r.top) / r.height, ...c }
  }
  function onCanvasPointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    const d = drag.current
    if (!d) return
    const r = e.currentTarget.getBoundingClientRect()
    const clamp = (v: number): number => Math.min(1, Math.max(0, v))
    const x = clamp(d.x + (e.clientX - r.left) / r.width - d.px)
    const y = clamp(d.y + (e.clientY - r.top) / r.height - d.py)
    setStyleState((s) => ({ ...s, customPosition: { x, y } }))
  }
  function onCanvasPointerUp(): void {
    if (!drag.current) return
    drag.current = null
    // 動かし終わったら覚える(動かしている間は書き込まない)
    setStyleState((s) => {
      writeThumbnailStyle(s)
      return s
    })
  }

  function pickLook(item: LookItem): void {
    // 見た目だけを入れ替える。置き場所・回転は今のまま
    // テロップ用の見た目は文字が小さいので、今の文字の大きさに合わせて縁・余白ごと拡大する
    setStyle({
      ...scaleLook(item.style, style.fontSize / Math.max(1, item.style.fontSize)),
      position: style.position,
      customPosition: style.customPosition,
      rotation: style.rotation
    })
  }

  const pos = style.customPosition ?? null

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
      {candidates.length > 0 && (
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
      )}
      <div className="thumbnail-stage">
        <canvas
          ref={canvasRef}
          width={thumbWidth}
          height={thumbHeight}
          className={`thumbnail-canvas ${text.trim() ? 'draggable' : ''}`}
          style={thumbAspect}
          aria-label="サムネイルの見本(文字はドラッグで動かせます)"
          title={text.trim() ? '文字をドラッグして動かせます' : undefined}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
        />
        {!selected && (
          <span className="thumbnail-stage-note">
            <ImageIcon width={12} height={12} aria-hidden="true" />
            候補を作って選ぶと、ここに画が入ります(文字の見た目は先に決められます)
          </span>
        )}
      </div>
      <div className="thumbnail-text">
        <label className="prop-label" htmlFor="thumbnail-text">
          文字
        </label>
        <textarea
          id="thumbnail-text"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="サムネイルの文字(改行で2行に。**強調** で色を変える、漢字《かんじ》でふりがな)"
          className="thumbnail-text-input"
        />
      </div>
      <PropRow label="見た目">
        <button
          type="button"
          className="small-button look-open-button"
          title="テロップの種類ごとの見た目と、保存したスタイルを絵で選びます"
          onClick={() => setPickerOpen(true)}
        >
          <SparklesIcon width={12} height={12} />
          見た目を選ぶ…
        </button>
        <button
          type="button"
          className="small-button"
          title="サムネイルの文字の見た目を覚えます(テロップに貼り付けられます)"
          onClick={() => copyLook(style, 'サムネイルの文字')}
        >
          コピー
        </button>
        <button
          type="button"
          className="small-button"
          disabled={!clipStyle}
          title={
            clipStyle
              ? `${clipFrom} からコピーした見た目を貼り付けます(文字の大きさ・置き場所はそのまま)`
              : '先にテロップの「見た目をコピー」でコピーしてください'
          }
          onClick={() =>
            clipStyle &&
            // テロップの見た目は文字が小さいので、今の大きさに合わせて縁・余白ごと拡大する
            setStyle(
              scaleLook(
                { ...style, ...lookPatch(clipStyle, SECTION_IDS) },
                style.fontSize / Math.max(1, clipStyle.fontSize)
              )
            )
          }
        >
          貼り付け
        </button>
        <button
          type="button"
          className="link-button"
          title="サムネイルの文字を、はじめの見た目(太い黄色の文字・二重の縁)に戻します"
          onClick={() => setStyle(defaultThumbnailStyle())}
        >
          はじめに戻す
        </button>
      </PropRow>
      {pickerOpen && (
        <TelopLookPicker
          saved={captionPresets}
          sample={text.trim() || 'サムネイル'}
          onPick={pickLook}
          onClose={() => setPickerOpen(false)}
          hint="押すと、サムネイルの文字にすぐ当たります(置き場所はそのまま)。"
        />
      )}
      <TelopStyleFields
        style={style}
        onPatch={patch}
        placement={
          <>
            <PropRow label="配置" title="見本の文字をドラッグしても動かせます">
              <select
                aria-label="サムネイルの文字の配置"
                value={pos ? 'custom' : style.position}
                onChange={(e) => {
                  if (e.target.value === 'custom') return
                  patch({ position: e.target.value as TextPosition, customPosition: undefined })
                }}
              >
                <option value="top">上</option>
                <option value="center">中央</option>
                <option value="bottom">下</option>
                {pos && <option value="custom">自由配置</option>}
              </select>
              {pos && (
                <>
                  <span className="prop-unit">X</span>
                  <NumberSlider
                    slider={false}
                    label="横位置(%)"
                    value={pos.x}
                    onChange={(v) => patch({ customPosition: { x: v, y: pos.y } })}
                    min={0}
                    max={100}
                    scale={100}
                  />
                  <span className="prop-unit">Y</span>
                  <NumberSlider
                    slider={false}
                    label="縦位置(%)"
                    value={pos.y}
                    onChange={(v) => patch({ customPosition: { x: pos.x, y: v } })}
                    min={0}
                    max={100}
                    scale={100}
                    unit="%"
                  />
                </>
              )}
            </PropRow>
            <PropRow label="回転">
              <NumberSlider
                label="サムネイルの文字の回転"
                value={style.rotation}
                onChange={(v) => patch({ rotation: v })}
                min={-180}
                max={180}
                sliderMin={-30}
                sliderMax={30}
                unit="度"
              />
            </PropRow>
          </>
        }
      />
      <button
        className="primary-button thumbnail-download"
        onClick={handleDownload}
        disabled={!selected}
        title={selected ? undefined : '先に候補を作って選んでください'}
      >
        <DownloadIcon width={14} height={14} />
        PNGでダウンロード
      </button>
    </div>
  )
}

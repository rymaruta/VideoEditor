import { useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import type { TextPosition, TextStyle } from '@shared/types'
import { defaultTextStyle } from '@shared/textStyle'
import { textCanvasSize } from '@shared/resolution'
import { drawTelop, telopStrokeRings, type TelopContext } from '@shared/telop/render'
import { countStyleUsage } from '@shared/telop/styles'
import { listSpeakers, speakerColor } from '@shared/speaker'
import { useProjectStore } from '../store/projectStore'
import { usePresetStore, type CaptionPreset } from '../store/presetStore'
import { useMenuCommand } from '../lib/menuCommands'
import { PropRow, TelopStyleFields } from './TelopStyleFields'

/**
 * テロップスタイルの管理(テロップ > テロップスタイルの管理…)。デザイン案の「TelopStyles」。
 *
 * 左にスタイルの一覧(使っている本数)、中央に見本、右に見た目の設定。
 * OK を押すと、直したスタイルを使っているテロップ全部に反映する(取り消し1回で戻る)。
 * 「自動で使う場面」で話者を選ぶと、その話者の発言テロップにこのスタイルが付く。
 *
 * スタイルは企画をまたいで使う(番組のテロップは回が変わっても同じなので、毎回作り直さない)。
 */

type SampleBackground = 'frame' | 'gray' | 'white' | 'black'

const SAMPLE_BG: Record<Exclude<SampleBackground, 'frame'>, string> = {
  gray: '#5a5a5a',
  white: '#ffffff',
  black: '#000000'
}

/** 一覧の「あ」の見本の色(塗りと、いちばん外側の縁) */
function swatchColors(style: TextStyle): { fill: string; edge: string } {
  const rings = telopStrokeRings(style)
  return { fill: style.color, edge: rings.at(-1)?.color ?? 'transparent' }
}

export function TelopStyleDialog(): React.JSX.Element | null {
  const project = useProjectStore((s) => s.project)
  const restyleTextOverlays = useProjectStore((s) => s.restyleTextOverlays)
  const presets = usePresetStore((s) => s.captionPresets)
  const replaceCaptionPresets = usePresetStore((s) => s.replaceCaptionPresets)

  const [draft, setDraft] = useState<CaptionPreset[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sampleText, setSampleText] = useState('えっ？ ヤバイですよね')
  const [background, setBackground] = useState<SampleBackground>('frame')
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useMenuCommand((id) => {
    if (id !== 'telop.styles') return
    const copy = presets.map((p) => ({ ...p, style: { ...p.style } }))
    setDraft(copy)
    // 選んでいるテロップのスタイルがあれば、それを開いた状態にする
    const state = useProjectStore.getState()
    const overlay = state.project.textOverlays.find((o) => o.id === state.selectedOverlayId)
    setSelectedId(copy.find((p) => p.id === overlay?.styleId)?.id ?? copy[0]?.id ?? null)
  })

  const usage = useMemo(() => countStyleUsage(project.textOverlays), [project.textOverlays])
  const speakers = useMemo(() => {
    const fromProject = listSpeakers(project.textOverlays)
    const fromStyles = (draft ?? []).flatMap((p) => p.speakers ?? [])
    return [...new Set([...fromProject, ...fromStyles])]
  }, [project.textOverlays, draft])
  const selected = draft?.find((p) => p.id === selectedId) ?? null

  useEffect(() => {
    if (!draft) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDraft(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft])

  // 見本を描く。書き出し(長尺向け)と同じ関数で描くので、ここで見える絵がそのまま出る
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !selected) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width: w, height: h } = canvas
    ctx.clearRect(0, 0, w, h)
    const video = document.querySelector<HTMLVideoElement>('.preview-frame video')
    if (background === 'frame' && video && video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, w, h)
    } else {
      ctx.fillStyle = background === 'frame' ? SAMPLE_BG.gray : SAMPLE_BG[background]
      ctx.fillRect(0, 0, w, h)
    }
    // 見本は置き場所の設定に関係なく、枠の中ほどに出す(どの位置のスタイルでも見えるように)
    const style: TextStyle = { ...selected.style, customPosition: undefined, position: 'center' }
    drawTelop(
      ctx as unknown as TelopContext,
      { text: sampleText || ' ', startTime: 0, endTime: 1e9, style },
      // 登場の動きが終わった後の姿を見せる
      10,
      { width: w, height: h },
      textCanvasSize(project.aspectRatio)
    )
  }, [selected, sampleText, background, project.aspectRatio])

  if (!draft) return null

  function patchSelected(patch: Partial<CaptionPreset>): void {
    if (!selected) return
    setDraft((prev) => prev?.map((p) => (p.id === selected.id ? { ...p, ...patch } : p)) ?? prev)
  }

  function patchStyle(patch: Partial<TextStyle>): void {
    if (!selected) return
    patchSelected({ style: { ...selected.style, ...patch } })
  }

  function addStyle(base?: CaptionPreset): void {
    const next: CaptionPreset = base
      ? { id: uuid(), name: `${base.name} のコピー`, style: { ...base.style } }
      : { id: uuid(), name: '新しいスタイル', style: defaultTextStyle() }
    setDraft((prev) => [...(prev ?? []), next])
    setSelectedId(next.id)
  }

  function removeSelected(): void {
    if (!selected) return
    const used = usage.get(selected.id) ?? 0
    if (
      used > 0 &&
      !window.confirm(
        `「${selected.name}」は ${used} 本のテロップで使われています。削除しても、そのテロップの見た目は今のまま残ります。削除しますか?`
      )
    )
      return
    const rest = draft!.filter((p) => p.id !== selected.id)
    setDraft(rest)
    setSelectedId(rest[0]?.id ?? null)
  }

  function toggleSpeaker(speaker: string, on: boolean): void {
    if (!selected) return
    // 1人の話者に付くスタイルは1つだけ(どれを使うか迷わないように、他のスタイルからは外す)
    setDraft(
      (prev) =>
        prev?.map((p) => {
          const rest = (p.speakers ?? []).filter((s) => s !== speaker)
          if (p.id === selected.id) {
            const next = on ? [...rest, speaker] : rest
            return { ...p, speakers: next.length > 0 ? next : undefined }
          }
          return on && rest.length !== (p.speakers ?? []).length
            ? { ...p, speakers: rest.length > 0 ? rest : undefined }
            : p
        }) ?? prev
    )
  }

  function handleOk(): void {
    const next = draft!.map((p) => ({ ...p, name: p.name.trim() || '名前のないスタイル' }))
    replaceCaptionPresets(next)
    restyleTextOverlays(usePresetStore.getState().captionPresets)
    setDraft(null)
  }

  const usedCount = selected ? (usage.get(selected.id) ?? 0) : 0
  const autoSpeakers = new Set(selected?.speakers ?? [])

  return (
    <div className="modal-backdrop" onMouseDown={() => setDraft(null)}>
      <div
        className="telop-style-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="テロップスタイルの管理"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-titlebar">
          <span>テロップスタイルの管理</span>
          <button className="dialog-close" aria-label="閉じる" onClick={() => setDraft(null)}>
            ×
          </button>
        </div>

        <div className="telop-style-body">
          <div className="telop-style-list-pane">
            <div className="export-dialog-section telop-style-list-head">スタイル</div>
            <ul className="telop-style-list" role="listbox" aria-label="スタイル">
              {draft.length === 0 && (
                <li className="hint-text telop-style-empty">
                  まだありません。「新規」で作るか、テロップの設定欄の「保存…」で今の見た目を登録できます。
                </li>
              )}
              {draft.map((p) => {
                const { fill, edge } = swatchColors(p.style)
                return (
                  <li
                    key={p.id}
                    role="option"
                    aria-selected={p.id === selectedId}
                    className={`telop-style-item ${p.id === selectedId ? 'selected' : ''}`}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <span
                      className="telop-style-glyph"
                      style={{
                        color: fill,
                        WebkitTextStroke: edge === 'transparent' ? undefined : `3px ${edge}`,
                        paintOrder: 'stroke fill'
                      }}
                    >
                      あ
                    </span>
                    <span className="telop-style-meta">
                      <span className="telop-style-name">{p.name || '名前のないスタイル'}</span>
                      <span className="telop-style-use">
                        {(usage.get(p.id) ?? 0).toLocaleString()} 本
                        {p.speakers?.length ? ` · ${p.speakers.join('、')}` : ''}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
            <div className="telop-style-list-actions">
              <button className="small-button" onClick={() => addStyle()}>
                新規
              </button>
              <button
                className="small-button"
                disabled={!selected}
                onClick={() => selected && addStyle(selected)}
              >
                複製
              </button>
              <button className="small-button danger" disabled={!selected} onClick={removeSelected}>
                削除
              </button>
            </div>
          </div>

          <div className="telop-style-sample-pane">
            <canvas
              ref={canvasRef}
              className="telop-style-sample"
              width={project.aspectRatio === '9:16' ? 360 : 640}
              height={project.aspectRatio === '9:16' ? 640 : 360}
            />
            <div className="telop-style-sample-controls">
              <label>
                見本の文字
                <input
                  type="text"
                  value={sampleText}
                  onChange={(e) => setSampleText(e.target.value)}
                />
              </label>
              <label>
                背景
                <select
                  value={background}
                  onChange={(e) => setBackground(e.target.value as SampleBackground)}
                >
                  <option value="frame">現在のフレーム</option>
                  <option value="gray">グレー</option>
                  <option value="white">白</option>
                  <option value="black">黒</option>
                </select>
              </label>
            </div>
            {selected && (
              <div className="telop-style-auto">
                <span className="export-dialog-section">自動で使う場面</span>
                {speakers.length === 0 ? (
                  <p className="hint-text">
                    テロップに話者が付くと、ここで「この話者の発言テロップに使う」を選べます。
                  </p>
                ) : (
                  speakers.map((sp) => (
                    <label key={sp} className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={autoSpeakers.has(sp)}
                        onChange={(e) => toggleSpeaker(sp, e.target.checked)}
                      />
                      <span className="prop-swatch" style={{ background: speakerColor(sp) }} />
                      話者が「{sp}」の発言テロップ
                    </label>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="telop-style-settings">
            {selected ? (
              <div className="telop-inspector">
                <PropRow label="名前">
                  <input
                    type="text"
                    aria-label="スタイルの名前"
                    value={selected.name}
                    onChange={(e) => patchSelected({ name: e.target.value })}
                  />
                </PropRow>
                <TelopStyleFields style={selected.style} onPatch={patchStyle} />
                <PropRow label="既定の位置">
                  <select
                    value={selected.style.position}
                    onChange={(e) =>
                      patchStyle({
                        position: e.target.value as TextPosition,
                        customPosition: undefined
                      })
                    }
                  >
                    <option value="top">上</option>
                    <option value="center">中央</option>
                    <option value="bottom">下</option>
                  </select>
                </PropRow>
              </div>
            ) : (
              <p className="hint-text telop-style-empty">
                スタイルを選ぶと、ここで見た目を変えられます。
              </p>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <span className="dialog-footer-label">
            {selected
              ? usedCount > 0
                ? `変更は、このスタイルを使っているテロップ ${usedCount.toLocaleString()} 本に反映されます`
                : 'このスタイルを使っているテロップはまだありません'
              : ''}
          </span>
          <div className="dialog-footer-spacer" />
          <button className="small-button" onClick={() => setDraft(null)}>
            キャンセル
          </button>
          <button className="primary-button" onClick={handleOk}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import type { TextPosition, TextStyle } from '@shared/types'
import { defaultTextStyle } from '@shared/textStyle'
import { textCanvasSize } from '@shared/resolution'
import { drawTelop, telopStrokeRings, type TelopContext } from '@shared/telop/render'
import { applyLook, countStyleUsage } from '@shared/telop/styles'
import { listSpeakers, speakerColor } from '@shared/speaker'
import { useProjectStore } from '../store/projectStore'
import { usePresetStore, type CaptionPreset } from '../store/presetStore'
import { useMenuCommand } from '../lib/menuCommands'
import { loadTelopFonts } from '../lib/telopFonts'
import { buildStyleFile, parseStyleFile, uniqueStyleNames } from '../lib/telopStyleFile'
import { formatIpcError } from '../lib/ipcError'
import { safeFileBaseName } from '@shared/fileName'
import { PropRow, TelopStyleFields } from './TelopStyleFields'
import { Segmented } from './AppearanceControls'
import { TelopLookGallery, type LookItem } from './TelopLookGallery'
import { useStyleClipboard } from '../lib/styleClipboard'
import { lookPatch, SECTION_IDS } from '../lib/appearanceEdit'

/**
 * テロップスタイルの管理(テロップ > テロップスタイルの管理…)。デザイン案の「TelopStyles」。
 *
 * 左にスタイルの一覧(使っている本数)、中央に見本と見た目の一覧(プリセット)、右に見た目の設定。
 * 見た目の一覧を押すと、選んでいるスタイルにその見た目を当てる(または新しいスタイルにする)。
 * OK を押すと、直したスタイルを使っているテロップ全部に反映する(取り消し1回で戻る)。
 * 「自動で使う場面」で話者を選ぶと、その話者の発言テロップにこのスタイルが付く。
 *
 * スタイルは企画をまたいで使う(番組のテロップは回が変わっても同じなので、毎回作り直さない)。
 */

/** 動きの見本の長さ(出てから消えるまで)と、次に出るまでの間 */
const PLAY_SECONDS = 3
const PLAY_GAP_SECONDS = 0.6

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
  // 見た目の一覧を押したとき: 選んでいるスタイルに当てる / 新しいスタイルとして足す
  const [pickMode, setPickMode] = useState<'apply' | 'new'>('apply')
  const [fontEpoch, setFontEpoch] = useState(0)
  const [playing, setPlaying] = useState(false)
  // スタイルのファイルの読み込み・書き出しの結果
  const clipStyle = useStyleClipboard((s) => s.style)
  const clipFrom = useStyleClipboard((s) => s.from)
  const copyLook = useStyleClipboard((s) => s.copy)
  const [fileMessage, setFileMessage] = useState<{ text: string; error?: boolean } | null>(null)
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

  // 同梱フォントは使うまで読み込まれないので、見本の文字と書体を先に読み込んで描き直す
  useEffect(() => {
    if (!selected) return
    let alive = true
    void loadTelopFonts([{ text: sampleText, style: selected.style }]).then((changed) => {
      if (alive && changed) setFontEpoch((e) => e + 1)
    })
    return () => {
      alive = false
    }
  }, [selected, sampleText])

  // 見本を描く。書き出しと同じ関数で描くので、ここで見える絵がそのまま出る。
  // 「動きを再生」中は、出てから消えるまで(PLAY_SECONDS 秒)を繰り返し描く
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !selected) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width: w, height: h } = canvas
    // 見本は置き場所の設定に関係なく、枠の中ほどに出す(どの位置のスタイルでも見えるように)
    const style: TextStyle = { ...selected.style, customPosition: undefined, position: 'center' }
    const video = document.querySelector<HTMLVideoElement>('.preview-frame video')
    const paint = (time: number, endTime: number): void => {
      ctx.clearRect(0, 0, w, h)
      if (background === 'frame' && video && video.readyState >= 2) {
        // 縦横比を保って収める(プレビュー・書き出しと同じく、余白は黒)。引き伸ばすと
        // 9:16 の企画に 16:9 の画が縦長につぶれて見え、文字の大きさの見当が狂う
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, w, h)
        const vw = video.videoWidth || w
        const vh = video.videoHeight || h
        const k = Math.min(w / vw, h / vh)
        ctx.drawImage(video, (w - vw * k) / 2, (h - vh * k) / 2, vw * k, vh * k)
      } else {
        ctx.fillStyle = background === 'frame' ? SAMPLE_BG.gray : SAMPLE_BG[background]
        ctx.fillRect(0, 0, w, h)
      }
      drawTelop(
        ctx as unknown as TelopContext,
        { text: sampleText || ' ', startTime: 0, endTime, style },
        time,
        { width: w, height: h },
        textCanvasSize(project.aspectRatio)
      )
    }
    if (!playing) {
      // 登場の動きが終わった後の姿を見せる
      paint(10, 1e9)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number): void => {
      // 消えた後に少し間を空けてから、もう一度出す
      const t = ((now - t0) / 1000) % (PLAY_SECONDS + PLAY_GAP_SECONDS)
      paint(t, PLAY_SECONDS)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [selected, sampleText, background, project.aspectRatio, fontEpoch, playing])

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

  function pickLook(item: LookItem): void {
    if (pickMode === 'new' || !selected) {
      const next: CaptionPreset = { id: uuid(), name: item.name, style: { ...item.style } }
      setDraft((prev) => [...(prev ?? []), next])
      setSelectedId(next.id)
      return
    }
    patchSelected({ style: applyLook(selected.style, item.style) })
  }

  async function exportStyles(scope: 'selected' | 'all'): Promise<void> {
    if (!draft) return
    const list = scope === 'selected' ? (selected ? [selected] : []) : draft
    if (list.length === 0) return
    setFileMessage(null)
    const base =
      scope === 'selected' && selected
        ? safeFileBaseName(selected.name || 'テロップスタイル')
        : 'テロップスタイル'
    try {
      const path = await window.api.saveSubtitleFile(
        `${base}.json`,
        buildStyleFile(list.map((p) => ({ name: p.name, style: p.style }))),
        'json'
      )
      if (path) setFileMessage({ text: `${list.length} 個のスタイルを書き出しました: ${path}` })
    } catch (e) {
      setFileMessage({ text: `書き出せませんでした: ${formatIpcError(e)}`, error: true })
    }
  }

  async function importStyles(): Promise<void> {
    setFileMessage(null)
    try {
      const file = await window.api.openSubtitleFile('json')
      if (!file) return
      const parsed = parseStyleFile(file.text)
      if (!parsed.ok) {
        setFileMessage({ text: parsed.error, error: true })
        return
      }
      const added: CaptionPreset[] = uniqueStyleNames(draft ?? [], parsed.styles).map((s) => ({
        id: uuid(),
        name: s.name,
        style: s.style
      }))
      setDraft((prev) => [...(prev ?? []), ...added])
      setSelectedId(added[0].id)
      setFileMessage({
        text:
          `${added.length} 個のスタイルを読み込みました(OK で確定します)` +
          (parsed.skipped > 0 ? `。読めなかった ${parsed.skipped} 個は飛ばしました` : '')
      })
    } catch (e) {
      setFileMessage({ text: `読み込めませんでした: ${formatIpcError(e)}`, error: true })
    }
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
            <div className="telop-style-list-actions telop-style-file-actions">
              <button
                className="small-button"
                title="ほかの PC・番組で作ったテロップスタイルのファイル(.json)を読み込みます"
                aria-label="スタイルを読み込む"
                onClick={() => void importStyles()}
              >
                読み込む…
              </button>
              <select
                className="telop-style-export"
                aria-label="スタイルを書き出す"
                title="テロップスタイルをファイル(.json)に書き出して、ほかの PC・番組で使えるようにします"
                value=""
                disabled={draft.length === 0}
                onChange={(e) => {
                  const v = e.target.value
                  e.target.value = ''
                  if (v === 'selected' || v === 'all') void exportStyles(v)
                }}
              >
                <option value="">書き出す…</option>
                <option value="selected" disabled={!selected}>
                  選んでいるスタイル
                </option>
                <option value="all">すべてのスタイル({draft.length})</option>
              </select>
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
              <button
                type="button"
                className={`small-button ${playing ? 'active' : ''}`}
                aria-pressed={playing}
                title={`入り・出・ループの動きを、${PLAY_SECONDS} 秒のテロップとして繰り返し再生します`}
                onClick={() => setPlaying((v) => !v)}
              >
                {playing ? '■ 止める' : '▶ 動きを再生'}
              </button>
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
            <div className="telop-style-gallery">
              <div className="telop-style-gallery-head">
                <span className="export-dialog-section">見た目の一覧</span>
                <Segmented
                  label="見た目の一覧を押したとき"
                  value={selected ? pickMode : 'new'}
                  options={[
                    {
                      value: 'apply',
                      label: '選んだスタイルに当てる',
                      title: '左で選んでいるスタイルの見た目を、押した見た目に置き換えます'
                    },
                    {
                      value: 'new',
                      label: '新しいスタイルにする',
                      title: '押した見た目を、新しいスタイルとして一覧に足します'
                    }
                  ]}
                  onChange={setPickMode}
                />
              </div>
              <TelopLookGallery
                saved={draft.filter((p) => p.id !== selectedId)}
                savedSample={sampleText}
                onPick={pickLook}
              />
            </div>
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
                <PropRow label="見た目">
                  <button
                    type="button"
                    className="small-button"
                    title="このスタイルの見た目を覚えます(テロップ・サムネイルの文字に貼り付けられます)"
                    onClick={() => copyLook(selected.style, `スタイル「${selected.name}」`)}
                  >
                    見た目をコピー
                  </button>
                  <button
                    type="button"
                    className="small-button"
                    disabled={!clipStyle}
                    title={
                      clipStyle
                        ? `${clipFrom} からコピーした見た目を、このスタイルに貼り付けます(既定の位置はそのまま)`
                        : '先にテロップの「見た目をコピー」でコピーしてください'
                    }
                    onClick={() => clipStyle && patchStyle(lookPatch(clipStyle, SECTION_IDS))}
                  >
                    見た目を貼り付け
                  </button>
                </PropRow>
                <TelopStyleFields
                  style={selected.style}
                  onPatch={patchStyle}
                  placement={
                    <PropRow label="既定の位置">
                      <select
                        aria-label="既定の位置"
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
                  }
                />
              </div>
            ) : (
              <p className="hint-text telop-style-empty">
                スタイルを選ぶと、ここで見た目を変えられます。
              </p>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <span
            className={`dialog-footer-label ${fileMessage?.error ? 'telop-style-file-error' : ''}`}
            role={fileMessage ? 'status' : undefined}
          >
            {fileMessage
              ? fileMessage.text
              : selected
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

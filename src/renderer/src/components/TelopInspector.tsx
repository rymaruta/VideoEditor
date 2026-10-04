import { useId, useMemo, useState } from 'react'
import type { TextOverlay, TextPosition, TextStyle } from '@shared/types'
import { listSpeakers, speakerColor } from '@shared/speaker'
import { useProjectStore } from '../store/projectStore'
import { usePresetStore } from '../store/presetStore'
import { buildTimedClips, findTimedClipAt } from '../lib/timelineMath'
import { MIN_OVERLAY_DURATION } from '../lib/textOverlayPlacement'
import { CopyIcon, SparklesIcon, TrashIcon } from './icons'
import { PropRow, TelopStyleFields } from './TelopStyleFields'
import { NumberSlider, StyleSection } from './AppearanceControls'
import { TelopLookPicker, type LookItem } from './TelopLookGallery'
import { applyLook, styleForSpeaker } from '@shared/telop/styles'

/**
 * 選んだテロップ1本の設定。並びは
 * 本文 → 話者 → スタイル・見た目の一覧 → テキスト → 塗り → 縁 → 背景 → 影 → 光彩 →
 * 部分の装飾 → 矢印 → 位置・動き → 表示時間。
 * 「誰の発言か → どの見た目か → 細かい見た目 → 動き・置き場所 → 時間」の順に、
 * 上から決めていけば仕上がるように並べている。細かい見た目は見出しごとに畳める。
 */

function defaultPositionFraction(position: TextPosition): { x: number; y: number } {
  if (position === 'top') return { x: 0.5, y: 0.08 }
  if (position === 'bottom') return { x: 0.5, y: 0.9 }
  return { x: 0.5, y: 0.5 }
}

export function TelopInspector({ overlay: o }: { overlay: TextOverlay }): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const updateTextOverlay = useProjectStore((s) => s.updateTextOverlay)
  const addTextOverlay = useProjectStore((s) => s.addTextOverlay)
  const removeTextOverlay = useProjectStore((s) => s.removeTextOverlay)
  const selectOverlay = useProjectStore((s) => s.selectOverlay)
  const setTextOverlayLink = useProjectStore((s) => s.setTextOverlayLink)
  const presets = usePresetStore((s) => s.captionPresets)
  const addCaptionPreset = usePresetStore((s) => s.addCaptionPreset)
  const [presetName, setPresetName] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  // 一覧から当てた見た目(当てた後に手で直したら、枠の印は外す)
  const [picked, setPicked] = useState<{ key: string; style: TextStyle } | null>(null)
  // インスペクタとテロップタブの両方に同時に出るので、ID は置き場ごとに分ける
  const uid = useId()

  const speakers = useMemo(() => listSpeakers(project.textOverlays), [project.textOverlays])
  const linked = presets.find((p) => p.id === o.styleId) ?? null
  const timedClips = buildTimedClips(project)
  const clipUnder = ((): { id: string; index: number } | null => {
    const tc = findTimedClipAt(timedClips, o.startTime)
    if (!tc || o.startTime < tc.start || o.startTime >= tc.end) return null
    return { id: tc.clip.id, index: timedClips.indexOf(tc) + 1 }
  })()

  // 見た目を手で変えたら、スタイルとのつながりは外す(スタイルを直しても上書きされないように)
  const patch = (p: Partial<TextStyle>): void =>
    updateTextOverlay(o.id, { style: { ...o.style, ...p }, styleId: undefined })
  // 置き場所はテロップごとのもの。スタイルとのつながりは保つ
  const place = (p: Partial<TextStyle>): void =>
    updateTextOverlay(o.id, { style: { ...o.style, ...p } })

  function setSpeaker(value: string): void {
    const speaker = value || undefined
    // スタイルの付いていないテロップは、話者に割り当てたスタイルを自動で使う
    const auto = o.styleId ? null : styleForSpeaker(presets, speaker)
    updateTextOverlay(
      o.id,
      auto ? { speaker, styleId: auto.id, style: applyLook(o.style, auto.style) } : { speaker }
    )
  }
  const pos = o.style.customPosition ?? defaultPositionFraction(o.style.position)

  function pickLook(item: LookItem): void {
    const style = applyLook(o.style, item.style)
    // 保存したスタイルならつなぐ(直せばこのテロップにも反映される)。種類の見た目は個別の設定
    updateTextOverlay(o.id, { style, styleId: item.savedId })
    setPicked({ key: item.key, style })
  }
  const activeLook = linked
    ? `saved:${linked.id}`
    : picked && picked.style === o.style
      ? picked.key
      : null

  function savePreset(): void {
    const name = (presetName ?? '').trim()
    if (!name) return
    addCaptionPreset(name, o.style)
    // 保存したスタイルにこのテロップをつなぐ(直せばこのテロップにも反映される)
    const saved = usePresetStore.getState().captionPresets.at(-1)
    if (saved) updateTextOverlay(o.id, { styleId: saved.id })
    setPresetName(null)
  }

  return (
    <div className="telop-inspector">
      <div className="prop-text">
        <label htmlFor={`${uid}-text`} className="prop-label">
          本文
        </label>
        <textarea
          id={`${uid}-text`}
          rows={2}
          value={o.text}
          onChange={(e) => updateTextOverlay(o.id, { text: e.target.value })}
        />
      </div>

      <PropRow label="話者">
        <span className="prop-swatch" style={{ background: speakerColor(o.speaker) }} />
        <input
          type="text"
          list={`${uid}-speakers`}
          placeholder="(未設定)"
          value={o.speaker ?? ''}
          onChange={(e) => setSpeaker(e.target.value)}
        />
        <datalist id={`${uid}-speakers`}>
          {speakers.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        {o.source === 'auto' && <span className="project-badge">自動</span>}
      </PropRow>

      <PropRow label="スタイル">
        <select
          value={linked?.id ?? ''}
          onChange={(e) => {
            const next = presets.find((p) => p.id === e.target.value)
            // 見た目だけを入れ替える。手で動かした置き場所は残す
            if (next)
              updateTextOverlay(o.id, { styleId: next.id, style: applyLook(o.style, next.style) })
          }}
        >
          <option value="" disabled>
            {presets.length === 0 ? '(スタイルがありません)' : '(個別の設定)'}
          </option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {presetName === null ? (
          <button
            className="small-button"
            title="今の見た目を名前を付けて保存し、ほかのテロップでも選べるようにします"
            onClick={() => setPresetName('')}
          >
            スタイルとして保存…
          </button>
        ) : (
          <>
            <input
              type="text"
              autoFocus
              placeholder="スタイル名"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') savePreset()
                if (e.key === 'Escape') setPresetName(null)
              }}
            />
            <button className="small-button" disabled={!presetName.trim()} onClick={savePreset}>
              保存
            </button>
          </>
        )}
      </PropRow>

      <PropRow label="見た目">
        <button
          className="small-button look-open-button"
          title="テロップの種類ごとの見た目と、保存したスタイルを絵で選びます"
          onClick={() => setPickerOpen(true)}
        >
          <SparklesIcon width={12} height={12} />
          見た目を選ぶ…
        </button>
      </PropRow>
      {pickerOpen && (
        <TelopLookPicker
          saved={presets}
          sample={o.text}
          activeKey={activeLook}
          onPick={pickLook}
          onClose={() => setPickerOpen(false)}
        />
      )}

      <TelopStyleFields
        style={o.style}
        onPatch={patch}
        showKaraoke={Boolean(o.words && o.words.length > 0)}
        placement={
          <>
            <PropRow label="配置">
              <select
                value={o.style.customPosition ? 'custom' : o.style.position}
                onChange={(e) => {
                  if (e.target.value === 'custom') return
                  place({ position: e.target.value as TextPosition, customPosition: undefined })
                }}
              >
                <option value="top">上</option>
                <option value="center">中央</option>
                <option value="bottom">下</option>
                {o.style.customPosition && <option value="custom">自由配置</option>}
              </select>
              <span className="prop-unit">X</span>
              <input
                type="number"
                aria-label="横位置(%)"
                className="prop-num"
                min={0}
                max={100}
                value={Math.round(pos.x * 100)}
                onChange={(e) =>
                  place({
                    customPosition: {
                      x: Math.min(100, Math.max(0, Number(e.target.value))) / 100,
                      y: pos.y
                    }
                  })
                }
              />
              <span className="prop-unit">Y</span>
              <input
                type="number"
                aria-label="縦位置(%)"
                className="prop-num"
                min={0}
                max={100}
                value={Math.round(pos.y * 100)}
                onChange={(e) =>
                  place({
                    customPosition: {
                      x: pos.x,
                      y: Math.min(100, Math.max(0, Number(e.target.value))) / 100
                    }
                  })
                }
              />
              <span className="prop-unit">%</span>
            </PropRow>

            <PropRow label="回転">
              <NumberSlider
                label="回転"
                value={o.style.rotation}
                onChange={(v) => place({ rotation: v })}
                min={-180}
                max={180}
                unit="度"
              />
            </PropRow>
          </>
        }
      />

      <StyleSection id="timing" title="表示時間" defaultOpen>
        <PropRow label="表示時間">
          <input
            type="number"
            aria-label="開始(秒)"
            className="prop-num wide"
            step={0.1}
            min={0}
            value={o.startTime}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (!Number.isFinite(v)) return
              updateTextOverlay(o.id, {
                startTime: Math.min(Math.max(0, v), Math.max(0, o.endTime - MIN_OVERLAY_DURATION))
              })
            }}
          />
          <span className="prop-unit">〜</span>
          <input
            type="number"
            aria-label="終了(秒)"
            className="prop-num wide"
            step={0.1}
            min={o.startTime + MIN_OVERLAY_DURATION}
            value={o.endTime}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (!Number.isFinite(v)) return
              updateTextOverlay(o.id, { endTime: Math.max(v, o.startTime + MIN_OVERLAY_DURATION) })
            }}
          />
          <span className="prop-unit">秒</span>
        </PropRow>

        <PropRow
          label="追従"
          title="手前のクリップを詰めても、このテロップが紐づいたクリップと一緒に動きます"
        >
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={Boolean(o.linkedClipId)}
              disabled={!o.linkedClipId && !clipUnder}
              onChange={(e) =>
                setTextOverlayLink(o.id, e.target.checked ? (clipUnder?.id ?? null) : null)
              }
            />
            {o.linkedClipId
              ? `クリップ${timedClips.findIndex((t) => t.clip.id === o.linkedClipId) + 1 || '?'}と一緒に動く`
              : clipUnder
                ? `クリップ${clipUnder.index}と一緒に動かす`
                : 'クリップの無い位置です'}
          </label>
        </PropRow>
      </StyleSection>

      <div className="prop-actions">
        <button
          className="small-button"
          onClick={() =>
            selectOverlay(
              addTextOverlay({
                text: o.text,
                startTime: o.startTime,
                endTime: o.endTime,
                style: { ...o.style },
                source: o.source,
                speaker: o.speaker,
                words: o.words ? o.words.map((w) => ({ ...w })) : undefined
              })
            )
          }
        >
          <CopyIcon width={12} height={12} />
          複製
        </button>
        <button className="small-button danger" onClick={() => removeTextOverlay(o.id)}>
          <TrashIcon width={12} height={12} />
          削除
        </button>
      </div>
    </div>
  )
}

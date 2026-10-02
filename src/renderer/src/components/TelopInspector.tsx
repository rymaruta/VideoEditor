import { useId, useMemo, useState } from 'react'
import type { FontFamily, TextAnimation, TextOverlay, TextPosition, TextStyle } from '@shared/types'
import { FONT_FAMILY_OPTIONS, TEXT_ANIMATION_MS } from '@shared/textStyle'
import { listSpeakers, speakerColor } from '@shared/speaker'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { usePresetStore, type CaptionPreset } from '../store/presetStore'
import { buildTimedClips, findTimedClipAt } from '../lib/timelineMath'
import { MIN_OVERLAY_DURATION } from '../lib/textOverlayPlacement'
import { CopyIcon, TrashIcon } from './icons'

/**
 * 選んだテロップ1本の設定。並びはデザイン案どおり
 * 本文 → 話者 → スタイル → 文字 → 塗り → 縁 → 外側の縁 → 影・帯 → 登場 → 配置 → 表示時間。
 * 「誰の発言か → どの見た目か → 細かい見た目 → 動き・置き場所 → 時間」の順に、
 * 上から決めていけば仕上がるように並べている。
 */

const ANIMATIONS: { value: TextAnimation; label: string }[] = [
  { value: 'none', label: 'なし' },
  { value: 'popIn', label: 'ポップ' },
  { value: 'fadeIn', label: 'フェード' },
  { value: 'slideInUp', label: '下から' },
  { value: 'slideInDown', label: '上から' },
  { value: 'bounce', label: '弾む' },
  { value: 'typewriter', label: '1文字ずつ' }
]

function defaultPositionFraction(position: TextPosition): { x: number; y: number } {
  if (position === 'top') return { x: 0.5, y: 0.08 }
  if (position === 'bottom') return { x: 0.5, y: 0.9 }
  return { x: 0.5, y: 0.5 }
}

/** 自由配置は置き場所の話なので、スタイルの一致を見るときは外す */
function lookKey(style: TextStyle): string {
  const rest: Partial<TextStyle> = { ...style }
  delete rest.customPosition
  return JSON.stringify(rest, Object.keys(rest).sort())
}

function matchingPreset(style: TextStyle, presets: readonly CaptionPreset[]): CaptionPreset | null {
  const key = lookKey(style)
  return presets.find((p) => lookKey(p.style) === key) ?? null
}

function PropRow({
  label,
  children,
  title
}: {
  label: string
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <div className="prop-row" title={title}>
      <span className="prop-label">{label}</span>
      <div className="prop-control">{children}</div>
    </div>
  )
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
  // 外側の縁・グラデーションは共通テロップレンダラ(長尺向けの書き出し)でだけ描ける
  const drawsTelopsOnCanvas = useSettingsStore((s) => s.exportEngine === 'segmented')
  const [presetName, setPresetName] = useState<string | null>(null)
  // インスペクタとテロップタブの両方に同時に出るので、ID は置き場ごとに分ける
  const uid = useId()

  const speakers = useMemo(() => listSpeakers(project.textOverlays), [project.textOverlays])
  const preset = matchingPreset(o.style, presets)
  const timedClips = buildTimedClips(project)
  const clipUnder = ((): { id: string; index: number } | null => {
    const tc = findTimedClipAt(timedClips, o.startTime)
    if (!tc || o.startTime < tc.start || o.startTime >= tc.end) return null
    return { id: tc.clip.id, index: timedClips.indexOf(tc) + 1 }
  })()

  const patch = (p: Partial<TextStyle>): void =>
    updateTextOverlay(o.id, { style: { ...o.style, ...p } })
  const pos = o.style.customPosition ?? defaultPositionFraction(o.style.position)
  const outer = o.style.extraStrokes?.[0]
  const usesCanvasOnly = Boolean(outer) || Boolean(o.style.gradientColor)

  function savePreset(): void {
    const name = (presetName ?? '').trim()
    if (!name) return
    addCaptionPreset(name, o.style)
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
          onChange={(e) => updateTextOverlay(o.id, { speaker: e.target.value || undefined })}
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
          value={preset?.id ?? ''}
          onChange={(e) => {
            const next = presets.find((p) => p.id === e.target.value)
            // 見た目だけを入れ替える。手で動かした置き場所は残す
            if (next)
              updateTextOverlay(o.id, {
                style: { ...next.style, customPosition: o.style.customPosition }
              })
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
            保存…
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

      <PropRow label="文字">
        <select
          aria-label="フォント"
          value={o.style.fontFamily}
          onChange={(e) => patch({ fontFamily: e.target.value as FontFamily })}
        >
          {FONT_FAMILY_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          aria-label="サイズ"
          className="prop-num"
          min={16}
          max={96}
          step={2}
          value={o.style.fontSize}
          onChange={(e) => patch({ fontSize: Number(e.target.value) })}
        />
        <span className="prop-unit">px</span>
        <button
          className={`toggle-chip ${o.style.bold ? 'active' : ''}`}
          aria-pressed={o.style.bold}
          title="太字"
          onClick={() => patch({ bold: !o.style.bold })}
        >
          B
        </button>
        <button
          className={`toggle-chip italic ${o.style.italic ? 'active' : ''}`}
          aria-pressed={o.style.italic}
          title="斜体"
          onClick={() => patch({ italic: !o.style.italic })}
        >
          I
        </button>
      </PropRow>

      <PropRow label="字間">
        <input
          type="number"
          className="prop-num"
          min={0}
          max={20}
          value={o.style.letterSpacing}
          onChange={(e) => patch({ letterSpacing: Number(e.target.value) })}
        />
        <span className="prop-unit">px</span>
      </PropRow>

      <PropRow label="塗り">
        <input
          type="color"
          aria-label="文字の色"
          value={o.style.color}
          onChange={(e) => patch({ color: e.target.value })}
        />
        <label className="checkbox-label" title="文字の色を上から下へのグラデーションにします">
          <input
            type="checkbox"
            checked={Boolean(o.style.gradientColor)}
            onChange={(e) => patch({ gradientColor: e.target.checked ? '#ffcc00' : undefined })}
          />
          グラデーション
        </label>
        {o.style.gradientColor && (
          <input
            type="color"
            aria-label="グラデーションの下の色"
            value={o.style.gradientColor}
            onChange={(e) => patch({ gradientColor: e.target.value })}
          />
        )}
      </PropRow>

      {o.words && o.words.length > 0 && (
        <PropRow label="カラオケ">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={o.style.wordHighlight}
              onChange={(e) => patch({ wordHighlight: e.target.checked })}
            />
            話した単語を色付け
          </label>
          {o.style.wordHighlight && (
            <input
              type="color"
              aria-label="色付けの色"
              value={o.style.highlightColor}
              onChange={(e) => patch({ highlightColor: e.target.value })}
            />
          )}
        </PropRow>
      )}

      <PropRow label="縁">
        <input
          type="checkbox"
          aria-label="縁を付ける"
          checked={o.style.outline}
          onChange={(e) => patch({ outline: e.target.checked })}
        />
        {o.style.outline && (
          <>
            <input
              type="color"
              aria-label="縁の色"
              value={o.style.outlineColor}
              onChange={(e) => patch({ outlineColor: e.target.value })}
            />
            <input
              type="number"
              aria-label="縁の太さ"
              className="prop-num"
              min={1}
              max={8}
              value={o.style.outlineWidth}
              onChange={(e) => patch({ outlineWidth: Number(e.target.value) })}
            />
            <span className="prop-unit">px</span>
          </>
        )}
      </PropRow>

      <PropRow label="外側の縁" title="縁のさらに外側にもう1本縁を付けます(バラエティの二重縁)">
        <input
          type="checkbox"
          aria-label="外側の縁を付ける"
          checked={Boolean(outer)}
          onChange={(e) =>
            patch({ extraStrokes: e.target.checked ? [{ color: '#ffffff', width: 6 }] : undefined })
          }
        />
        {outer && (
          <>
            <input
              type="color"
              aria-label="外側の縁の色"
              value={outer.color}
              onChange={(e) => patch({ extraStrokes: [{ ...outer, color: e.target.value }] })}
            />
            <input
              type="number"
              aria-label="外側の縁の太さ"
              className="prop-num"
              min={1}
              max={20}
              value={outer.width}
              onChange={(e) =>
                patch({ extraStrokes: [{ ...outer, width: Number(e.target.value) }] })
              }
            />
            <span className="prop-unit">px</span>
          </>
        )}
      </PropRow>
      {!drawsTelopsOnCanvas && usesCanvasOnly && (
        <p className="hint-text prop-note">
          外側の縁・グラデーションは、書き出し方式が「長尺向け」のときに表示・書き出しされます。
        </p>
      )}

      <PropRow label="影">
        <input
          type="checkbox"
          aria-label="影を付ける"
          checked={o.style.shadow}
          onChange={(e) => patch({ shadow: e.target.checked })}
        />
      </PropRow>

      <PropRow label="帯(座布団)">
        <input
          type="checkbox"
          aria-label="帯を敷く"
          checked={o.style.background}
          onChange={(e) => patch({ background: e.target.checked })}
        />
        {o.style.background && (
          <>
            <input
              type="color"
              aria-label="帯の色"
              value={o.style.backgroundColor}
              onChange={(e) => patch({ backgroundColor: e.target.value })}
            />
            <input
              type="range"
              aria-label="帯の濃さ"
              min={0}
              max={1}
              step={0.05}
              value={o.style.backgroundOpacity}
              onChange={(e) => patch({ backgroundOpacity: Number(e.target.value) })}
            />
            <span className="prop-unit">{Math.round(o.style.backgroundOpacity * 100)}%</span>
          </>
        )}
      </PropRow>

      <PropRow label="登場">
        <select
          value={o.style.animation}
          onChange={(e) => patch({ animation: e.target.value as TextAnimation })}
        >
          {ANIMATIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        {TEXT_ANIMATION_MS[o.style.animation] > 0 && (
          <span className="prop-unit">
            {(TEXT_ANIMATION_MS[o.style.animation] / 1000).toFixed(2)} 秒
          </span>
        )}
      </PropRow>

      <PropRow label="配置">
        <select
          value={o.style.customPosition ? 'custom' : o.style.position}
          onChange={(e) => {
            if (e.target.value === 'custom') return
            patch({ position: e.target.value as TextPosition, customPosition: undefined })
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
            patch({
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
            patch({
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
        <input
          type="number"
          className="prop-num"
          min={-180}
          max={180}
          value={o.style.rotation}
          onChange={(e) => patch({ rotation: Number(e.target.value) })}
        />
        <span className="prop-unit">度</span>
      </PropRow>

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

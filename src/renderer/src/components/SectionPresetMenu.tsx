import { useEffect, useRef, useState } from 'react'
import type { TextStyle } from '@shared/types'
import {
  CHAR_ANIMATION_LABEL,
  EXIT_ANIMATION_LABEL,
  FONT_FAMILY_OPTIONS,
  LOOP_ANIMATION_LABEL
} from '@shared/textStyle'
import {
  pickSection,
  SECTION_KEYS,
  SECTION_LABEL,
  type SectionPreset
} from '../lib/appearancePresets'
import {
  isSectionDefault,
  sectionDefaultPatch,
  sectionMatches,
  sectionPatch
} from '../lib/appearanceEdit'
import { useStyleClipboard } from '../lib/styleClipboard'
import { loadTelopFonts } from '../lib/telopFonts'
import { useSettingsStore } from '../store/settingsStore'
import { Popover } from './Popover'
import { drawLookThumb } from '../lib/lookThumb'

/**
 * 項目ごとの「マイ設定」(Photoshop のスタイル・CapCut のプリセットを項目単位にしたもの)。
 * 見出しの右の「☰」から開く。
 *
 * - 今のこの項目の値を、名前を付けて保存する(どの企画・どのテロップでも使える)
 * - 保存したものを押すと、この項目だけが置き換わる(ほかの項目はそのまま)
 * - 見本は、今の見た目にその設定を当てた姿を書き出しと同じ描き方で描く
 * - 消しても、すぐ下の「元に戻す」で戻せる
 * - この項目だけのコピー / 貼り付け、既定に戻す
 */

const ANIMATION_LABEL: Record<string, string> = {
  none: 'なし',
  popIn: 'ポップ',
  fadeIn: 'フェード',
  slideInUp: '下から',
  slideInDown: '上から',
  bounce: '弾む',
  typewriter: '1文字ずつ'
}

/** 見本の文(項目の効き目が見える文) */
function sampleText(section: string): string {
  if (section === 'spans') return '第1話\n**¥980**__税込__'
  if (section === 'pointer') return 'ここ!'
  return 'テロップ'
}

/** 見本の絵では分からない項目(動き)の説明 */
function describe(section: string, values: Partial<TextStyle>): string | null {
  if (section === 'motion') {
    const parts: string[] = []
    if (values.animation && values.animation !== 'none')
      parts.push(`入り: ${ANIMATION_LABEL[values.animation] ?? values.animation}`)
    if (values.charAnimation && values.charAnimation !== 'none')
      parts.push(`1文字ずつ: ${CHAR_ANIMATION_LABEL[values.charAnimation]}`)
    if (values.exitAnimation && values.exitAnimation !== 'none')
      parts.push(`出: ${EXIT_ANIMATION_LABEL[values.exitAnimation]}`)
    if (values.loopAnimation && values.loopAnimation !== 'none')
      parts.push(`ループ: ${LOOP_ANIMATION_LABEL[values.loopAnimation]}`)
    if (values.animationSpeed && values.animationSpeed !== 1)
      parts.push(`×${values.animationSpeed}`)
    return parts.length > 0 ? parts.join(' / ') : '動きなし'
  }
  if (section === 'text') {
    const f = FONT_FAMILY_OPTIONS.find((o) => o.value === values.fontFamily)
    return `${f?.label.split(/[((]/)[0].trim() ?? ''} ${values.fontSize ?? ''}px`
  }
  return null
}

function PresetSwatch({
  section,
  base,
  values
}: {
  section: string
  base: TextStyle
  values: Partial<TextStyle>
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const [epoch, setEpoch] = useState(0)
  const style = { ...base, ...sectionPatch(section, values) }
  const text = sampleText(section)
  const key = JSON.stringify(style)
  useEffect(() => {
    let alive = true
    void loadTelopFonts([{ text, style }]).then((changed) => {
      if (alive && changed) setEpoch((e) => e + 1)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, text])
  useEffect(() => {
    if (ref.current) drawLookThumb(ref.current, text, style, 0.86, 12)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, text, epoch])
  return (
    <canvas
      ref={ref}
      className="section-preset-swatch"
      width={160}
      height={72}
      aria-hidden="true"
    />
  )
}

export function SectionPresetMenu({
  section,
  style,
  onApply,
  title
}: {
  section: string
  style: TextStyle
  /** 当てる差分(この項目のキーだけ。消すキーは undefined) */
  onApply: (patch: Partial<TextStyle>) => void
  title: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const presets = useSettingsStore((s) => s.sectionPresets[section]) ?? []
  const label = SECTION_LABEL[section] ?? title
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`section-menu-button ${open ? 'open' : ''}`}
        aria-label={`${label}のマイ設定(保存・呼び出し・既定に戻す)`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${label}のマイ設定: 今の設定を保存・保存した設定を当てる・既定に戻す`}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        </svg>
        {presets.length > 0 && <span className="section-menu-count">{presets.length}</span>}
      </button>
      {open && (
        <Popover
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          label={`${label}のマイ設定`}
          className="section-preset-popover"
        >
          <SectionPresetPanel
            section={section}
            label={label}
            style={style}
            presets={presets}
            onApply={onApply}
          />
        </Popover>
      )}
    </>
  )
}

function SectionPresetPanel({
  section,
  label,
  style,
  presets,
  onApply
}: {
  section: string
  label: string
  style: TextStyle
  presets: SectionPreset[]
  onApply: (patch: Partial<TextStyle>) => void
}): React.JSX.Element {
  const addPreset = useSettingsStore((s) => s.addSectionPreset)
  const removePreset = useSettingsStore((s) => s.removeSectionPreset)
  const restorePreset = useSettingsStore((s) => s.restoreSectionPreset)
  const clip = useStyleClipboard((s) => s.style)
  const copy = useStyleClipboard((s) => s.copy)
  const [name, setName] = useState<string | null>(null)
  const [removed, setRemoved] = useState<{ preset: SectionPreset; index: number } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const keys = SECTION_KEYS[section] ?? []
  const current = pickSection(style, keys)
  const savedAs = presets.find((p) => sectionMatches(style, section, p.values))
  const atDefault = isSectionDefault(style, section)
  const fallbackName = `${label} ${presets.length + 1}`

  const save = (): void => {
    const n = (name ?? '').trim() || fallbackName
    const overwrite = presets.some((p) => p.name === n)
    addPreset(section, n, current)
    setName(null)
    setMessage(overwrite ? `「${n}」を上書きしました` : `「${n}」を保存しました`)
  }

  return (
    <div className="section-preset-panel">
      <div className="section-preset-head">
        <span className="section-preset-title">{label}のマイ設定</span>
        <span className="section-preset-sub">どのテロップ・企画でも使えます</span>
      </div>

      {name === null ? (
        <button
          type="button"
          className="small-button section-preset-save"
          disabled={Boolean(savedAs)}
          title={
            savedAs
              ? `今の${label}は「${savedAs.name}」として保存済みです`
              : `今の${label}の設定に名前を付けて保存します`
          }
          onClick={() => {
            setMessage(null)
            setName('')
          }}
        >
          {savedAs ? `保存済み(${savedAs.name})` : 'この設定を保存…'}
        </button>
      ) : (
        <div className="section-preset-name">
          <input
            type="text"
            autoFocus
            data-escape-local
            aria-label="マイ設定の名前"
            placeholder={fallbackName}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') {
                e.stopPropagation()
                setName(null)
              }
            }}
          />
          <button type="button" className="primary-button" onClick={save}>
            保存
          </button>
          <button type="button" className="small-button" onClick={() => setName(null)}>
            やめる
          </button>
          {presets.some((p) => p.name === (name.trim() || fallbackName)) && (
            <span className="section-preset-warn">同じ名前のものを上書きします</span>
          )}
        </div>
      )}

      {presets.length === 0 ? (
        <p className="section-preset-empty">
          まだありません。よく使う{label}の組み合わせを保存すると、ここから1回で当てられます。
        </p>
      ) : (
        <ul className="section-preset-list" aria-label={`保存した${label}の設定`}>
          {presets.map((p) => {
            const active = savedAs?.id === p.id
            const note = describe(section, p.values)
            return (
              <li key={p.id} className={`section-preset-item ${active ? 'active' : ''}`}>
                <button
                  type="button"
                  className="section-preset-apply"
                  aria-pressed={active}
                  title={`「${p.name}」を当てる(${label}だけが置き換わります)`}
                  onClick={() => {
                    onApply(sectionPatch(section, p.values))
                    setMessage(`「${p.name}」を当てました(Ctrl+Z で戻せます)`)
                  }}
                >
                  <PresetSwatch section={section} base={style} values={p.values} />
                  <span className="section-preset-meta">
                    <span className="section-preset-item-name">{p.name}</span>
                    {note && <span className="section-preset-note">{note}</span>}
                  </span>
                  {active && <span className="section-preset-check">✓</span>}
                </button>
                <button
                  type="button"
                  className="icon-chip danger section-preset-remove"
                  aria-label={`「${p.name}」を消す`}
                  title="このマイ設定を消す(すぐ下で元に戻せます)"
                  onClick={() => {
                    const index = (
                      useSettingsStore.getState().sectionPresets[section] ?? []
                    ).findIndex((x) => x.id === p.id)
                    removePreset(section, p.id)
                    setRemoved({ preset: p, index })
                    setMessage(null)
                  }}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {removed && (
        <div className="section-preset-undo" role="status">
          <span>「{removed.preset.name}」を消しました</span>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              // 元の id・位置へ戻す(作り直すと、間に保存した同じ名前の設定を上書きしてしまう)
              restorePreset(section, removed.preset, removed.index)
              setRemoved(null)
            }}
          >
            元に戻す
          </button>
        </div>
      )}
      {message && !removed && (
        <p className="section-preset-message" role="status">
          {message}
        </p>
      )}

      <div className="section-preset-foot">
        <button
          type="button"
          className="small-button"
          title={`今の${label}の設定だけをコピーします(ほかのテロップの「${label}」に貼り付けられます)`}
          onClick={() => {
            copy(style, `${label}`)
            setMessage(`${label}をコピーしました`)
          }}
        >
          コピー
        </button>
        <button
          type="button"
          className="small-button"
          disabled={!clip}
          title={
            clip
              ? `コピーした見た目の${label}だけを貼り付けます`
              : '先に「コピー」か、テロップの「見た目をコピー」でコピーしてください'
          }
          onClick={() => {
            if (!clip) return
            onApply(sectionPatch(section, pickSection(clip, keys)))
            setMessage(`${label}を貼り付けました`)
          }}
        >
          貼り付け
        </button>
        <span className="section-preset-foot-spacer" />
        <button
          type="button"
          className="small-button"
          disabled={atDefault}
          title={
            atDefault
              ? `${label}は既定のままです`
              : `${label}を、新しいテロップと同じ既定の設定に戻します`
          }
          onClick={() => {
            onApply(sectionDefaultPatch(section))
            setMessage(`${label}を既定に戻しました`)
          }}
        >
          既定に戻す
        </button>
      </div>
    </div>
  )
}

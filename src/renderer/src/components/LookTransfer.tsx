import { useMemo, useRef, useState } from 'react'
import type { TextOverlay, TextStyle } from '@shared/types'
import { stripTelopMarkup } from '@shared/telop/render'
import { SECTION_LABEL } from '../lib/appearancePresets'
import { lookPatch, SECTION_IDS, telopTargetGroups, type TargetGroup } from '../lib/appearanceEdit'
import { useStyleClipboard } from '../lib/styleClipboard'
import { useProjectStore } from '../store/projectStore'
import { ClipboardPasteIcon, CopyIcon } from './icons'
import { Popover } from './Popover'

/**
 * 見た目のコピー・貼り付けと、ほかのテロップへの一括の当て方
 * (Premiere の「属性をコピー / ペースト」、CapCut の「すべてに適用」)。
 *
 * - 「見た目をコピー」: 置き場所・回転・本文以外の見た目を覚える
 * - 「貼り付け…」: どの項目を貼るか(テキスト・塗り・縁…)と、どこに貼るか(このテロップ / 同じ見た目 /
 *   同じ話者 / すべて)を選ぶ
 * - 「ほかにも当てる…」: 今のテロップの見た目を、同じ話者・すべてのテロップなどに広げる
 *
 * どれも取り消し(Ctrl+Z)1回で戻る(まとめて1回の変更にする)。
 */

const SECTIONS_KEY = 've-look-paste-sections'

function readSections(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? 'null') as unknown
    if (Array.isArray(raw)) {
      const ok = raw.filter((x): x is string => (SECTION_IDS as readonly string[]).includes(x))
      if (ok.length > 0) return ok
    }
  } catch {
    // 読めなければ全部
  }
  return [...SECTION_IDS]
}

function writeSections(list: string[]): void {
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(list))
  } catch {
    // 覚えられなくても今回は使える
  }
}

function shortText(text: string): string {
  const t = stripTelopMarkup(text).replace(/\s+/g, ' ').trim()
  return t.length > 14 ? `${t.slice(0, 14)}…` : t
}

export function LookTransfer({ overlay: o }: { overlay: TextOverlay }): React.JSX.Element {
  const clip = useStyleClipboard((s) => s.style)
  const clipFrom = useStyleClipboard((s) => s.from)
  const copy = useStyleClipboard((s) => s.copy)
  const [mode, setMode] = useState<'paste' | 'spread' | null>(null)
  const [copied, setCopied] = useState(false)
  const pasteRef = useRef<HTMLButtonElement>(null)
  const spreadRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="look-transfer">
      <button
        type="button"
        className="small-button"
        title="このテロップの見た目(置き場所・本文以外)を覚えます。ほかのテロップで「貼り付け…」できます"
        onClick={() => {
          copy(o.style, `「${shortText(o.text)}」`)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }}
      >
        <CopyIcon width={12} height={12} />
        {copied ? 'コピーしました' : '見た目をコピー'}
      </button>
      <button
        ref={pasteRef}
        type="button"
        className="small-button"
        disabled={!clip}
        aria-haspopup="dialog"
        aria-expanded={mode === 'paste'}
        title={
          clip
            ? `${clipFrom} からコピーした見た目を貼り付けます(項目と貼る先を選べます)`
            : '先にほかのテロップで「見た目をコピー」してください'
        }
        onClick={() => setMode(mode === 'paste' ? null : 'paste')}
      >
        <ClipboardPasteIcon width={12} height={12} />
        貼り付け…
      </button>
      <button
        ref={spreadRef}
        type="button"
        className="small-button"
        aria-haspopup="dialog"
        aria-expanded={mode === 'spread'}
        title="このテロップの見た目を、同じ話者・同じスタイル・すべてのテロップにまとめて当てます"
        onClick={() => setMode(mode === 'spread' ? null : 'spread')}
      >
        ほかにも当てる…
      </button>
      {mode && (
        <Popover
          anchorRef={mode === 'paste' ? pasteRef : spreadRef}
          onClose={() => setMode(null)}
          label={mode === 'paste' ? '見た目を貼り付け' : '見た目をほかのテロップにも当てる'}
          className="look-transfer-popover"
        >
          <LookApplyPanel
            mode={mode}
            overlay={o}
            source={mode === 'paste' ? clip : o.style}
            sourceLabel={mode === 'paste' ? clipFrom : `「${shortText(o.text)}」`}
            onDone={() => setMode(null)}
          />
        </Popover>
      )}
    </div>
  )
}

function LookApplyPanel({
  mode,
  overlay: o,
  source,
  sourceLabel,
  onDone
}: {
  mode: 'paste' | 'spread'
  overlay: TextOverlay
  source: TextStyle | null
  sourceLabel: string
  onDone: () => void
}): React.JSX.Element {
  const overlays = useProjectStore((s) => s.project.textOverlays)
  const updateTextOverlaysStyle = useProjectStore((s) => s.updateTextOverlaysStyle)
  const [sections, setSections] = useState<string[]>(readSections)
  const targets = useMemo<TargetGroup[]>(() => {
    const groups = telopTargetGroups(overlays, o)
    // 広げるときは「今と同じ見た目」は意味が無い(もう同じ)
    return mode === 'paste'
      ? [{ id: 'this' as const, label: 'このテロップ', ids: [o.id] }, ...groups]
      : groups.filter((g) => g.id !== 'same-look')
  }, [overlays, o, mode])
  const [target, setTarget] = useState<string>(() => targets[0]?.id ?? '')
  const chosen = targets.find((t) => t.id === target) ?? targets[0]
  const toggle = (id: string, on: boolean): void => {
    const next = on
      ? SECTION_IDS.filter((s) => s === id || sections.includes(s))
      : sections.filter((s) => s !== id)
    setSections(next)
    writeSections(next)
  }
  const all = sections.length === SECTION_IDS.length

  const apply = (): void => {
    if (!source || !chosen || sections.length === 0) return
    updateTextOverlaysStyle(chosen.ids, lookPatch(source, sections))
    onDone()
  }

  return (
    <div className="look-apply-panel">
      <div className="section-preset-head">
        <span className="section-preset-title">
          {mode === 'paste' ? '見た目を貼り付け' : 'この見た目をほかにも当てる'}
        </span>
        <span className="section-preset-sub">元: {sourceLabel}</span>
      </div>
      <fieldset className="look-apply-sections">
        <legend>
          当てる項目
          <button
            type="button"
            className="link-button"
            onClick={() => {
              const next = all ? [] : [...SECTION_IDS]
              setSections(next)
              writeSections(next)
            }}
          >
            {all ? 'すべて外す' : 'すべて選ぶ'}
          </button>
        </legend>
        {SECTION_IDS.map((id) => (
          <label key={id} className="checkbox-label">
            <input
              type="checkbox"
              checked={sections.includes(id)}
              onChange={(e) => toggle(id, e.target.checked)}
            />
            {SECTION_LABEL[id]}
          </label>
        ))}
      </fieldset>
      <fieldset className="look-apply-targets">
        <legend>当てる先</legend>
        {targets.length === 0 ? (
          <p className="section-preset-empty">
            ほかに当てる先がありません(話者・スタイルの同じテロップがありません)。
          </p>
        ) : (
          targets.map((t) => (
            <label key={t.id} className="checkbox-label">
              <input
                type="radio"
                name={`look-target-${mode}`}
                checked={chosen?.id === t.id}
                onChange={() => setTarget(t.id)}
              />
              {t.label}
              <span className="look-apply-count">{t.ids.length} 本</span>
            </label>
          ))
        )}
      </fieldset>
      <p className="section-preset-sub look-apply-note">
        置き場所・回転・本文はそのままです。取り消し(Ctrl+Z)1回で戻せます。
      </p>
      <div className="section-preset-foot">
        <span className="section-preset-foot-spacer" />
        <button type="button" className="small-button" onClick={onDone}>
          やめる
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={!source || !chosen || sections.length === 0}
          onClick={apply}
        >
          {chosen && chosen.ids.length > 1 ? `${chosen.ids.length} 本に当てる` : '当てる'}
        </button>
      </div>
    </div>
  )
}

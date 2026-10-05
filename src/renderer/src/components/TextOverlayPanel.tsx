import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { getTotalDuration } from '../store/projectStore'
import type { FontFamily, TextOverlay, TextPosition, TextStyle } from '@shared/types'
import { defaultTextStyle, FONT_FAMILY_OPTIONS } from '@shared/textStyle'
import { speakerColor } from '@shared/speaker'
import { parseBulkFontSize } from '../lib/textOverlayInput'
import { clampPage, pageCount, pageForTime, pageSlice } from '../lib/listPaging'
import { newOverlayRange } from '../lib/textOverlayPlacement'
import { formatTimecode } from '../lib/timelineRuler'
import { frameSeconds } from '@shared/frameRate'
import { TelopInspector } from './TelopInspector'
import { TelopToolsBar } from './TelopToolsBar'
import { ColorField } from './ColorField'
import { PlusIcon, TypeIcon } from './icons'
import { stripTelopMarkup } from '@shared/telop/render'
import { CATEGORY_LABEL, CATEGORY_ORDER, HOW_LABEL, TELOP_KINDS } from '@shared/telop/kinds'

/**
 * テロップ(デザイン案の「テロップ」タブ)。左に一覧、右に選んだテロップの設定。
 *
 * - 一覧は1行 = 1本(時刻・話者の色・本文)。クリックで選んでその位置へ移る
 * - Ctrl+クリック / Shift+クリックで複数を選ぶと、右側がまとめて変更する欄になる
 * - 選択はタイムラインと共有(どちらで選んでも同じものが選ばれる)
 *
 * 再生位置は**押した瞬間に読む**(購読しない)。購読すると再生中は毎フレームこのパネル全体が
 * 描き直され、テロップが多い企画ほど重くなる(実測: テロップ1,000本・60分の企画で、
 * 再生中のフレーム間隔が 167ms=約6fps まで落ちていた)。
 */

/** 一覧の1ページの件数。1行が軽いので、設定欄を並べていた頃(50件)より多く出せる */
const LIST_PAGE = 200

export function TextOverlayPanel(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const addTextOverlay = useProjectStore((s) => s.addTextOverlay)
  const shiftAllTextOverlays = useProjectStore((s) => s.shiftAllTextOverlays)
  const updateTextOverlaysStyle = useProjectStore((s) => s.updateTextOverlaysStyle)
  const selectedOverlayId = useProjectStore((s) => s.selectedOverlayId)
  const selectOverlay = useProjectStore((s) => s.selectOverlay)
  const seekTo = useProjectStore((s) => s.seekTo)

  const [shiftAmount, setShiftAmount] = useState(0.5)
  // 複数選択(一覧の中だけで持つ)。ストアの選択を含んでいるときだけ有効
  const [multiIds, setMultiIds] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  /** 一覧は時刻順(足した順のままだと、後から足したテロップが末尾に紛れる) */
  const sorted = useMemo(
    () =>
      [...project.textOverlays].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime),
    [project.textOverlays]
  )
  const fps = Math.round(1 / frameSeconds(project.clips, project.assets))
  const selected = sorted.find((o) => o.id === selectedOverlayId) ?? null
  const effectiveMulti =
    selected && multiIds.has(selected.id) && multiIds.size > 1 ? multiIds : null
  const multiOverlays = effectiveMulti ? sorted.filter((o) => effectiveMulti.has(o.id)) : []

  // タイムラインで選ばれたら、そのテロップの載っているページを開いて見える位置まで送る
  useEffect(
    () =>
      useProjectStore.subscribe((state, prev) => {
        if (!state.selectedOverlayId || state.selectedOverlayId === prev.selectedOverlayId) return
        const list = [...state.project.textOverlays].sort(
          (a, b) => a.startTime - b.startTime || a.endTime - b.endTime
        )
        const index = list.findIndex((o) => o.id === state.selectedOverlayId)
        if (index >= 0) setPage(Math.floor(index / LIST_PAGE))
      }),
    []
  )
  useEffect(() => {
    listRef.current?.querySelector('.telop-row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selectedOverlayId, page])

  function handleRowClick(e: React.MouseEvent, o: TextOverlay): void {
    if (e.ctrlKey || e.metaKey) {
      const base = effectiveMulti ?? new Set(selected ? [selected.id] : [])
      const next = new Set(base)
      if (next.has(o.id) && next.size > 1) next.delete(o.id)
      else next.add(o.id)
      setMultiIds(next)
      // 主の選択は「最後に触ったもの」。外した場合は残りのどれかへ
      selectOverlay(next.has(o.id) ? o.id : [...next][0])
      return
    }
    if (e.shiftKey && selected) {
      const a = sorted.indexOf(selected)
      const b = sorted.indexOf(o)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setMultiIds(new Set(sorted.slice(lo, hi + 1).map((x) => x.id)))
      selectOverlay(o.id)
      return
    }
    setMultiIds(new Set([o.id]))
    selectOverlay(o.id)
    seekTo(o.startTime)
  }

  function handleAdd(): void {
    const store = useProjectStore.getState()
    // 置く位置は**再生位置**(規則は newOverlayRange)
    const id = addTextOverlay({
      text: '新しいテキスト',
      ...newOverlayRange(store.playheadTime, getTotalDuration(project)),
      style: defaultTextStyle(),
      source: 'manual'
    })
    setMultiIds(new Set([id]))
    selectOverlay(id)
  }

  /** 種類から足す(見本の文と、その種類の見た目・長さで) */
  function handleAddKind(kindId: string): void {
    const kind = TELOP_KINDS.find((k) => k.id === kindId)
    if (!kind) return
    const store = useProjectStore.getState()
    const id = addTextOverlay({
      text: kind.sample,
      ...newOverlayRange(store.playheadTime, getTotalDuration(project), kind.seconds),
      style: kind.style(),
      source: 'manual'
    })
    setMultiIds(new Set([id]))
    selectOverlay(id)
  }

  const currentPage = clampPage(page, sorted.length, LIST_PAGE)
  const range = pageSlice(currentPage, sorted.length, LIST_PAGE)
  const pages = pageCount(sorted.length, LIST_PAGE)

  return (
    <div className="telop-panel">
      <div className="telop-panel-body">
        <div className="telop-list-pane">
          <div className="telop-list-head">
            <span>テロップ {sorted.length.toLocaleString()}件</span>
            <button
              className="small-button"
              onClick={handleAdd}
              title="再生位置にテロップを足します"
            >
              <PlusIcon width={12} height={12} />
              追加
            </button>
            <select
              className="telop-kind-add"
              aria-label="種類から追加"
              title={`${TELOP_KINDS.length} 種類の見た目と見本の文から、再生位置に足します`}
              value=""
              onChange={(e) => {
                handleAddKind(e.target.value)
                e.target.value = ''
              }}
            >
              <option value="">種類から追加…</option>
              {CATEGORY_ORDER.map((c) => (
                <optgroup key={c} label={CATEGORY_LABEL[c]}>
                  {TELOP_KINDS.filter((k) => k.category === c).map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                      {k.how === 'manual' ? '' : `(${HOW_LABEL[k.how]})`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <TelopToolsBar
            onSelect={(id) => {
              setMultiIds(new Set([id]))
              selectOverlay(id)
            }}
          />
          {sorted.length === 0 ? (
            <div className="empty-state">
              <TypeIcon width={22} height={22} />
              <p className="hint-text">
                テロップはありません。「追加」か、テロップメニューの「音声から自動でテロップを作る」で作れます。
              </p>
            </div>
          ) : (
            <ul className="telop-list" ref={listRef} role="listbox" aria-multiselectable="true">
              {sorted.slice(range.start, range.end).map((o) => {
                const isSel = o.id === selectedOverlayId || Boolean(effectiveMulti?.has(o.id))
                return (
                  <li
                    key={o.id}
                    role="option"
                    aria-selected={isSel}
                    className={`telop-row ${isSel ? 'selected' : ''}`}
                    style={{ borderLeftColor: speakerColor(o.speaker) }}
                    title={
                      o.speaker
                        ? `${o.speaker}: ${stripTelopMarkup(o.text)}`
                        : stripTelopMarkup(o.text)
                    }
                    onClick={(e) => handleRowClick(e, o)}
                  >
                    <span className="telop-row-tc">{formatTimecode(o.startTime, fps)}</span>
                    <span className="telop-row-text">
                      {stripTelopMarkup(o.text).replace(/\n/g, ' ') || '(空)'}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          {pages > 1 && (
            <div className="telop-list-paging">
              <button
                className="small-button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                前へ
              </button>
              <span>
                {range.start + 1}〜{range.end}
              </span>
              <button
                className="small-button"
                disabled={currentPage >= pages - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                次へ
              </button>
              <button
                className="small-button"
                title="再生位置のテロップが載っているページへ移ります"
                onClick={() =>
                  setPage(pageForTime(sorted, useProjectStore.getState().playheadTime, LIST_PAGE))
                }
              >
                再生位置へ
              </button>
            </div>
          )}
          {sorted.length > 0 && (
            <div
              className="telop-list-foot"
              title="すべてのテロップの開始・終了をまとめてずらします"
            >
              <span>全体をずらす</span>
              <input
                type="number"
                aria-label="ずらす秒数"
                step={0.1}
                value={shiftAmount}
                onChange={(e) => setShiftAmount(Number(e.target.value))}
              />
              <span>秒</span>
              <button className="small-button" onClick={() => shiftAllTextOverlays(-shiftAmount)}>
                早める
              </button>
              <button className="small-button" onClick={() => shiftAllTextOverlays(shiftAmount)}>
                遅らせる
              </button>
            </div>
          )}
        </div>

        <div className="telop-detail-pane">
          {effectiveMulti ? (
            <BulkStyleEditor
              overlays={multiOverlays}
              onApply={(patch) =>
                updateTextOverlaysStyle(
                  multiOverlays.map((o) => o.id),
                  patch
                )
              }
            />
          ) : selected ? (
            <TelopInspector key={selected.id} overlay={selected} />
          ) : (
            <div className="empty-state">
              <p className="hint-text">
                一覧かタイムラインでテロップを選ぶと、ここで本文・話者・見た目を変えられます。
                Ctrl+クリックで複数を選ぶと、まとめて変更できます。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 複数のテロップの見た目をまとめて変える。値が揃っていない項目は「(混在)」と出す */
function BulkStyleEditor({
  overlays,
  onApply
}: {
  overlays: readonly TextOverlay[]
  onApply: (patch: Partial<TextStyle>) => void
}): React.JSX.Element {
  function common<K extends keyof TextStyle>(key: K): TextStyle[K] | undefined {
    const first = overlays[0]?.style[key]
    return overlays.every((o) => o.style[key] === first) ? first : undefined
  }
  return (
    <div className="telop-inspector">
      <p className="prop-heading">{overlays.length}件をまとめて変更</p>
      <div className="prop-row">
        <span className="prop-label">フォント</span>
        <div className="prop-control">
          <select
            value={common('fontFamily') ?? ''}
            onChange={(e) => onApply({ fontFamily: e.target.value as FontFamily })}
          >
            {common('fontFamily') === undefined && <option value="">(混在)</option>}
            {FONT_FAMILY_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="prop-row">
        <span className="prop-label">サイズ</span>
        <div className="prop-control">
          <input
            type="number"
            className="prop-num"
            min={16}
            max={96}
            step={2}
            placeholder="混在"
            value={common('fontSize') ?? ''}
            onChange={(e) => {
              const size = parseBulkFontSize(e.target.value)
              if (size !== null) onApply({ fontSize: size })
            }}
          />
          <span className="prop-unit">px</span>
        </div>
      </div>
      <div className="prop-row">
        <span className="prop-label">塗り</span>
        <div className="prop-control">
          <ColorField
            label="文字の色"
            value={common('color') ?? '#ffffff'}
            mixed={common('color') === undefined}
            onChange={(hex) => onApply({ color: hex })}
          />
          {common('color') === undefined && <span className="prop-unit">(混在)</span>}
        </div>
      </div>
      <div className="prop-row">
        <span className="prop-label">配置</span>
        <div className="prop-control">
          <select
            value={common('position') ?? ''}
            onChange={(e) =>
              // 自由配置が残っているとそちらが優先されて、位置を変えたのに画面が動かない
              onApply({ position: e.target.value as TextPosition, customPosition: undefined })
            }
          >
            {common('position') === undefined && <option value="">(混在)</option>}
            <option value="top">上</option>
            <option value="center">中央</option>
            <option value="bottom">下</option>
          </select>
        </div>
      </div>
    </div>
  )
}

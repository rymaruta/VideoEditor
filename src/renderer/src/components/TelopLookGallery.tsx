import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TextStyle } from '@shared/types'
import * as telopKinds from '@shared/telop/kinds'
import { HOW_LABEL, TELOP_KINDS, type TelopKindInfo } from '@shared/telop/kinds'
import { loadTelopFonts } from '../lib/telopFonts'
import { matchesLookQuery } from '../lib/appearanceEdit'
import { drawLookThumb } from '../lib/lookThumb'
import { SearchIcon } from './icons'

/**
 * 見た目の一覧(CapCut の「テキスト > スタイル」のような、絵で選ぶプリセット)。
 * テロップの種類ごとの見た目と、保存したスタイルを小さな見本で並べる。
 * 見本は書き出しと同じ `drawTelop` で描くので、選んだとおりに出る。
 *
 * 種類が多い(100 以上)ので、
 * - 上の「分類」で絞り、検索欄で名前・使いどころ・見本の文から探せる
 * - 見本は画面に入ったものだけを描く(開くのが一瞬で済むように)
 */

export interface LookItem {
  key: string
  name: string
  /** 見本の文 */
  text: string
  style: TextStyle
  /** 保存したスタイルなら、その ID */
  savedId?: string
  group: string
  /** 検索で見る文(使いどころなど) */
  keywords?: string
}

const THUMB_W = 240
const THUMB_H = 135

const SAVED_GROUP = '保存したスタイル'
const ALL = 'すべて'

/** 種類の分類名(分類が無い古い種類は、自動 / AI / 人が置く で分ける) */
function categoryOf(k: TelopKindInfo): string {
  const cat = (k as TelopKindInfo & { category?: string }).category
  const labels = (telopKinds as unknown as { CATEGORY_LABEL?: Record<string, string> })
    .CATEGORY_LABEL
  if (cat) return labels?.[cat] ?? cat
  return HOW_LABEL[k.how]
}

function kindItem(k: TelopKindInfo): LookItem {
  return {
    key: `kind:${k.id}`,
    name: k.label,
    text: k.sample,
    style: k.style(),
    group: categoryOf(k),
    keywords: `${k.use} ${k.sample} ${HOW_LABEL[k.how]}`
  }
}

/** 種類ごとの見た目(決まった値なので1回だけ作る) */
let kindItems: LookItem[] | null = null
function allKindItems(): LookItem[] {
  if (!kindItems) kindItems = TELOP_KINDS.map(kindItem)
  return kindItems
}

/** 保存したスタイルの見本(スタイルの値ごと。値が変わらなければ同じ見本を使う) */
const savedItems = new WeakMap<TextStyle, LookItem>()

/**
 * 種類ごとの見た目 + 保存したスタイル。変わっていない見本は前と同じものを返す
 * (見本は中身が変わったときだけ描き直す。スタイルの管理で1つを直すたびに、
 * 見えている見本を全部描き直していた)
 */
function buildLookItems(
  saved: readonly { id: string; name: string; style: TextStyle }[],
  savedSample: string
): LookItem[] {
  return [
    ...saved.map((s) => {
      const key = `saved:${s.id}`
      const name = s.name || '名前のないスタイル'
      const prev = savedItems.get(s.style)
      if (prev && prev.key === key && prev.name === name && prev.text === savedSample) return prev
      const item = {
        key,
        name,
        text: savedSample,
        style: s.style,
        savedId: s.id,
        group: SAVED_GROUP
      }
      savedItems.set(s.style, item)
      return item
    }),
    ...allKindItems()
  ]
}

/** 見本1枚。画面に入ってから描く(100 枚以上を一度に描くと開くのが遅くなる) */
function LookThumb({ item, epoch }: { item: LookItem; epoch: number }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  // IntersectionObserver が無ければ最初から描く
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  const [fontEpoch, setFontEpoch] = useState(0)
  useEffect(() => {
    const c = ref.current
    if (!c || visible) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    io.observe(c)
    return () => io.disconnect()
  }, [visible])
  // 見えたら、その見本の書体を読み込んでから描き直す
  useEffect(() => {
    if (!visible) return
    let alive = true
    void loadTelopFonts([item]).then((changed) => {
      if (alive && changed) setFontEpoch((e) => e + 1)
    })
    return () => {
      alive = false
    }
  }, [visible, item])
  useEffect(() => {
    const c = ref.current
    if (c && visible) drawLookThumb(c, item.text, item.style)
  }, [item, epoch, visible, fontEpoch])
  return (
    <canvas
      ref={ref}
      className="look-thumb"
      width={THUMB_W * 2}
      height={THUMB_H * 2}
      aria-hidden="true"
    />
  )
}

export function TelopLookGallery({
  saved,
  savedSample = 'えっ？ ヤバイですよね',
  onPick,
  activeKey,
  showSaved = true,
  autoFocusSearch = false
}: {
  saved: readonly { id: string; name: string; style: TextStyle }[]
  savedSample?: string
  onPick: (item: LookItem) => void
  /** 今当たっている見た目(枠で囲む) */
  activeKey?: string | null
  showSaved?: boolean
  autoFocusSearch?: boolean
}): React.JSX.Element {
  const items = useMemo(
    () => buildLookItems(showSaved ? saved : [], savedSample),
    [saved, savedSample, showSaved]
  )
  const [epoch, setEpoch] = useState(0)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(ALL)

  // 同梱フォントは使うまで読み込まれない。どこかで読み込めたら、見えている見本を描き直す
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    let alive = true
    const onDone = (): void => {
      if (alive) setEpoch((e) => e + 1)
    }
    fonts?.addEventListener?.('loadingdone', onDone)
    return () => {
      alive = false
      fonts?.removeEventListener?.('loadingdone', onDone)
    }
  }, [])

  const categories = useMemo(() => {
    const out: { group: string; count: number }[] = []
    for (const it of items) {
      const g = out.find((x) => x.group === it.group)
      if (g) g.count++
      else out.push({ group: it.group, count: 1 })
    }
    return out
  }, [items])
  const activeCategory = categories.some((c) => c.group === category) ? category : ALL

  const groups = useMemo(() => {
    const out: { group: string; items: LookItem[] }[] = []
    for (const it of items) {
      if (activeCategory !== ALL && it.group !== activeCategory) continue
      if (!matchesLookQuery(it, query)) continue
      const g = out.find((x) => x.group === it.group)
      if (g) g.items.push(it)
      else out.push({ group: it.group, items: [it] })
    }
    return out
  }, [items, activeCategory, query])

  return (
    <div className="look-gallery">
      <div className="look-gallery-bar">
        <label className="look-search">
          <SearchIcon width={13} height={13} aria-hidden="true" />
          <input
            type="search"
            aria-label="見た目を探す"
            placeholder="名前・使いどころで探す(例: ツッコミ、値段)"
            autoFocus={autoFocusSearch}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation()
                setQuery('')
              }
            }}
          />
        </label>
        {categories.length > 1 && (
          <div className="look-cats" role="tablist" aria-label="見た目の分類">
            {[{ group: ALL, count: items.length }, ...categories].map((c) => (
              <button
                key={c.group}
                type="button"
                role="tab"
                aria-selected={activeCategory === c.group}
                className={`look-cat ${activeCategory === c.group ? 'active' : ''}`}
                onClick={() => setCategory(c.group)}
              >
                {c.group}
                <span className="look-cat-count">{c.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {groups.length === 0 && (
        <p className="hint-text look-empty">
          「{query}」に合う見た目はありません。言葉を変えるか、分類を「すべて」にしてください。
        </p>
      )}
      {groups.map((g) => (
        <div key={g.group} className="look-group">
          <div className="look-group-head">
            {g.group}
            <span className="look-group-count">{g.items.length}</span>
          </div>
          <div className="look-grid" role="list">
            {g.items.map((it) => (
              <button
                key={it.key}
                type="button"
                role="listitem"
                className={`look-item ${activeKey === it.key ? 'active' : ''}`}
                title={`「${it.name}」の見た目にする`}
                aria-label={`見た目「${it.name}」`}
                aria-pressed={activeKey === it.key}
                onClick={() => onPick(it)}
              >
                <LookThumb item={it} epoch={epoch} />
                <span className="look-name">{it.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 見た目の一覧を出す窓(テロップの設定欄の「見た目を選ぶ…」から開く) */
export function TelopLookPicker({
  saved,
  onPick,
  onClose,
  activeKey,
  sample,
  hint = '押すと、選んでいるテロップにすぐ当たります(置き場所はそのまま)。取り消し(Ctrl+Z)で戻せます。'
}: {
  saved: readonly { id: string; name: string; style: TextStyle }[]
  onPick: (item: LookItem) => void
  onClose: () => void
  activeKey?: string | null
  sample?: string
  hint?: string
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 検索欄に字があるときの Esc は、まず検索を消す(窓は閉じない)
      const t = e.target as HTMLInputElement | null
      if (t?.matches?.('.look-search input') && t.value) return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop look-picker-backdrop" onMouseDown={onClose}>
      <div
        className="look-picker"
        role="dialog"
        aria-modal="true"
        aria-label="見た目を選ぶ"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-titlebar">
          <span>見た目を選ぶ</span>
          <button className="dialog-close" aria-label="閉じる" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="hint-text look-picker-hint">{hint}</p>
        <div className="look-picker-body">
          <TelopLookGallery
            saved={saved}
            savedSample={sample}
            onPick={onPick}
            activeKey={activeKey}
            autoFocusSearch
          />
        </div>
        <div className="dialog-footer">
          <div className="dialog-footer-spacer" />
          <button className="primary-button" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

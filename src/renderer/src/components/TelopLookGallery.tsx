import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TextStyle } from '@shared/types'
import { drawTelop, layoutTelop, type TelopContext } from '@shared/telop/render'
import { HOW_LABEL, TELOP_KINDS, type TelopKindInfo } from '@shared/telop/kinds'
import { loadTelopFonts } from '../lib/telopFonts'

/**
 * 見た目の一覧(CapCut の「テキスト > スタイル」のような、絵で選ぶプリセット)。
 * テロップの種類ごとの見た目と、保存したスタイルを小さな見本で並べる。
 * 見本は書き出しと同じ `drawTelop` で描くので、選んだとおりに出る。
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
}

/** 見本の仮想キャンバスの基準(本物と同じ 16:9 の 1080) */
const BASE_CANVAS = { w: 1920, h: 1080 }
const THUMB_W = 240
const THUMB_H = 135

const SAVED_GROUP = '保存したスタイル'

/** 写真のような落ち着いた背景(空 → 地面)。白い文字・黒い文字どちらも見える明るさ */
function paintBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#7d97ad')
  g.addColorStop(0.45, '#a9a395')
  g.addColorStop(0.62, '#6f7259')
  g.addColorStop(1, '#3d4236')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, w * 0.7)
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(1, 'rgba(0,0,0,0.35)')
  ctx.fillStyle = v
  ctx.fillRect(0, 0, w, h)
}

/** 見本を1枚描く(置き場所は無視して中央に) */
function drawLookThumb(canvas: HTMLCanvasElement, text: string, style: TextStyle): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width: w, height: h } = canvas
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  paintBackdrop(ctx, w, h)
  ctx.restore()
  const centered: TextStyle = {
    ...style,
    position: 'center',
    customPosition: undefined,
    // 見本は登場の動きを終えた姿で見せる
    animation: 'none'
  }
  const source = { text: text || ' ', startTime: 0, endTime: 1e9, style: centered }
  // 小さな見本でも読めるよう、文字の塊が枠の 8 割ほどになるまで寄って描く
  // (仮想キャンバスを小さくする = 拡大。塊が収まる大きさなので折り返しは変わらない)
  const layout = layoutTelop(ctx as unknown as TelopContext, source, BASE_CANVAS)
  const reach =
    (style.outline ? style.outlineWidth : 0) +
    (style.extraStrokes ?? []).reduce((a, s) => a + s.width, 0)
  const bw = layout.blockWidth + reach * 2 + (style.background ? layout.fontSize : 0)
  const bh = layout.blockHeight + reach * 2 + (style.background ? layout.fontSize * 0.6 : 0)
  const zoom = Math.max(
    1,
    Math.min(4, (BASE_CANVAS.w * 0.8) / Math.max(1, bw), (BASE_CANVAS.h * 0.6) / Math.max(1, bh))
  )
  drawTelop(
    ctx as unknown as TelopContext,
    source,
    1,
    { width: w, height: h },
    {
      w: BASE_CANVAS.w / zoom,
      h: BASE_CANVAS.h / zoom
    }
  )
}

function kindItem(k: TelopKindInfo): LookItem {
  return {
    key: `kind:${k.id}`,
    name: k.label,
    text: k.sample,
    style: k.style(),
    group: HOW_LABEL[k.how]
  }
}

/** 種類ごとの見た目 + 保存したスタイル */
function buildLookItems(
  saved: readonly { id: string; name: string; style: TextStyle }[],
  savedSample: string
): LookItem[] {
  return [
    ...saved.map((s) => ({
      key: `saved:${s.id}`,
      name: s.name || '名前のないスタイル',
      text: savedSample,
      style: s.style,
      savedId: s.id,
      group: SAVED_GROUP
    })),
    ...TELOP_KINDS.map(kindItem)
  ]
}

function LookThumb({ item, epoch }: { item: LookItem; epoch: number }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (c) drawLookThumb(c, item.text, item.style)
  }, [item, epoch])
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
  showSaved = true
}: {
  saved: readonly { id: string; name: string; style: TextStyle }[]
  savedSample?: string
  onPick: (item: LookItem) => void
  /** 今当たっている見た目(枠で囲む) */
  activeKey?: string | null
  showSaved?: boolean
}): React.JSX.Element {
  const items = useMemo(
    () => buildLookItems(showSaved ? saved : [], savedSample),
    [saved, savedSample, showSaved]
  )
  const [epoch, setEpoch] = useState(0)

  // 同梱フォントは使うまで読み込まれない。読み込めたら描き直す
  useEffect(() => {
    let alive = true
    void loadTelopFonts(items).then((changed) => {
      if (alive && changed) setEpoch((e) => e + 1)
    })
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    const onDone = (): void => {
      if (alive) setEpoch((e) => e + 1)
    }
    fonts?.addEventListener?.('loadingdone', onDone)
    return () => {
      alive = false
      fonts?.removeEventListener?.('loadingdone', onDone)
    }
  }, [items])

  const groups = useMemo(() => {
    const out: { group: string; items: LookItem[] }[] = []
    for (const it of items) {
      const g = out.find((x) => x.group === it.group)
      if (g) g.items.push(it)
      else out.push({ group: it.group, items: [it] })
    }
    return out
  }, [items])

  return (
    <div className="look-gallery">
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
  sample
}: {
  saved: readonly { id: string; name: string; style: TextStyle }[]
  onPick: (item: LookItem) => void
  onClose: () => void
  activeKey?: string | null
  sample?: string
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
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
        <p className="hint-text look-picker-hint">
          押すと、選んでいるテロップにすぐ当たります(置き場所はそのまま)。取り消し(Ctrl+Z)で戻せます。
        </p>
        <div className="look-picker-body">
          <TelopLookGallery
            saved={saved}
            savedSample={sample}
            onPick={onPick}
            activeKey={activeKey}
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

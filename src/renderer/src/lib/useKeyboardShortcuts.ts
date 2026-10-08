import { useEffect } from 'react'
import { getTotalDuration, useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { saveProject } from './projectFileActions'
import { formatIpcError } from './ipcError'
import { getKeymap, matchesBinding } from './keymap'
import { frameSeconds } from '@shared/frameRate'

/**
 * 文字を打っている最中か。**この判定は必ずここから呼ぶこと。**
 * 各リスナが自前で書き写すと、あとから足した門(下の `isModalOpen`)が
 * 書き写した側に届かない——実際そうなっていた(理由は `SourceViewer` の keydown)。
 */
export function isTypingTarget(el: EventTarget | null, key?: string): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT') {
    // スライダー・チェックボックスは文字を打つ欄ではない。触った後に Space・S・Delete が
    // 効かなくなっていた。スライダーの矢印キー(値を動かす)は欄に任せる
    const type = (el as HTMLInputElement).type
    if (type === 'range') return key !== undefined && /^(Arrow|Home$|End$|Page)/.test(key)
    // チェックボックス・ラジオの Space(切り替え)は欄に任せる(再生にすると切り替えられなかった)
    if (type === 'checkbox') return key === ' ' || key === 'Enter'
    // ラジオは矢印キーで選び直す(再生位置を動かすと、選び直せなかった)
    if (type === 'radio') return key === ' ' || key === 'Enter' || /^Arrow/.test(key ?? '')
    if (type === 'button') return false
    return true
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

// While any modal dialog is open, timeline-wide shortcuts must not reach the
// timeline: Delete would remove the very clip the modal is editing behind the
// user's back, S would split it, Space would start playback behind the dialog.
export function isModalOpen(): boolean {
  return document.querySelector('.modal-backdrop') !== null
}

/**
 * タイムラインが隠れているか(ダイアログ、または画面全体を覆う自動編集の画面)。
 * 隠れている間は、見えないタイムラインを変える操作(Delete・分割・再生・道具の切り替え)を通さない
 * (自動編集の画面の後ろで Delete がクリップを消していた)。取り消し・やり直し・保存は通す
 */
export function isTimelineCovered(): boolean {
  return (
    document.querySelector('.modal-backdrop, .auto-edit-screen, [data-blocks-shortcuts]') !== null
  )
}

function selectedClipIds(store: ReturnType<typeof useProjectStore.getState>): string[] {
  if (store.multiSelectedClipIds.length > 0) return store.multiSelectedClipIds
  return store.selectedClipId ? [store.selectedClipId] : []
}

export function useKeyboardShortcuts(): void {
  const keymapScheme = useSettingsStore((s) => s.keymapScheme)

  useEffect(() => {
    const keymap = getKeymap(keymapScheme)

    function handleKeyDown(e: KeyboardEvent): void {
      // 保存は文字を打っている最中・ダイアログの上でも効かせる(メニューの Ctrl+S はここが受け持つので、
      // 欄に入っている間は何も起きなかった)
      if (matchesBinding(e, keymap.save)) {
        e.preventDefault()
        // Surface failures in the same spot as the toolbar save button — a silently
        // swallowed Ctrl+S error looks like a successful save and invites data loss.
        saveProject().catch((err) => {
          useProjectStore.getState().setSaveError(formatIpcError(err))
        })
        return
      }
      if (isTypingTarget(e.target, e.key)) return
      if (isModalOpen()) return
      const store = useProjectStore.getState()

      if (matchesBinding(e, keymap.undo)) {
        e.preventDefault()
        store.undo()
        return
      }
      if (matchesBinding(e, keymap.redo)) {
        e.preventDefault()
        store.redo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        store.redo()
        return
      }
      // ここから先はタイムラインを変える操作。自動編集の画面で隠れている間は通さない
      if (isTimelineCovered()) return
      if (matchesBinding(e, keymap.copy)) {
        e.preventDefault()
        store.copySelectedClip()
        return
      }
      if (matchesBinding(e, keymap.paste)) {
        e.preventDefault()
        store.pasteClip()
        return
      }
      if (matchesBinding(e, keymap.duplicate)) {
        const ids = selectedClipIds(store)
        if (ids.length > 0) {
          e.preventDefault()
          store.duplicateClips(ids)
        }
        return
      }
      if (matchesBinding(e, keymap.playPause)) {
        e.preventDefault()
        store.togglePlayback()
        return
      }
      if (matchesBinding(e, keymap.split)) {
        if (store.selectedClipId) {
          e.preventDefault()
          store.splitClipAtTime(store.selectedClipId, store.playheadTime)
        }
        return
      }
      if (matchesBinding(e, keymap.delete)) {
        const ids = selectedClipIds(store)
        if (ids.length > 0) {
          e.preventDefault()
          store.removeClips(ids)
        }
        return
      }
      if (
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        e.preventDefault()
        // 1フレームぶんは素材のフレームレートで決まる(書き出しと同じ関数)。
        // 固定の 1/30 だと、60fps の素材で「1フレーム移動」が2フレーム飛んでいた。
        const frame = frameSeconds(store.project.clips, store.project.assets)
        const step = e.shiftKey ? frame * 10 : frame
        const direction = e.key === 'ArrowLeft' ? -1 : 1
        const total = getTotalDuration(store.project)
        const next = Math.max(0, Math.min(total, store.playheadTime + direction * step))
        store.seekTo(next)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [keymapScheme])
}

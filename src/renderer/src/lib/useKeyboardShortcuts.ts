import { useEffect } from 'react'
import { getTotalDuration, useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { saveProject } from './projectFileActions'
import { getKeymap, matchesBinding } from './keymap'

const FRAME_SECONDS = 1 / 30
const FRAME_JUMP_SECONDS = FRAME_SECONDS * 10

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function useKeyboardShortcuts(): void {
  const keymapScheme = useSettingsStore((s) => s.keymapScheme)

  useEffect(() => {
    const keymap = getKeymap(keymapScheme)

    function handleKeyDown(e: KeyboardEvent): void {
      if (isTypingTarget(e.target)) return
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
      if (matchesBinding(e, keymap.save)) {
        e.preventDefault()
        saveProject().catch(() => {})
        return
      }
      if (matchesBinding(e, keymap.playPause)) {
        e.preventDefault()
        store.setIsPlaying(!store.isPlaying)
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
        const ids =
          store.multiSelectedClipIds.length > 0
            ? store.multiSelectedClipIds
            : store.selectedClipId
              ? [store.selectedClipId]
              : []
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
        const step = e.shiftKey ? FRAME_JUMP_SECONDS : FRAME_SECONDS
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

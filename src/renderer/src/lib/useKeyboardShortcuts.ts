import { useEffect } from 'react'
import { useProjectStore } from '../store/projectStore'

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (isTypingTarget(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      const store = useProjectStore.getState()

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) store.redo()
        else store.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        store.redo()
        return
      }
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        store.copySelectedClip()
        return
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        store.pasteClip()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        store.setIsPlaying(!store.isPlaying)
        return
      }
      if (e.key === 's' || e.key === 'S') {
        if (store.selectedClipId) {
          e.preventDefault()
          store.splitClipAtTime(store.selectedClipId, store.playheadTime)
        }
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (store.selectedClipId) {
          e.preventDefault()
          store.removeClip(store.selectedClipId)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}

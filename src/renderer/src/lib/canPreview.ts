import { toFileUrl } from './previewSource'

const PROBE_TIMEOUT_MS = 6000

/**
 * Whether the preview <video> can actually decode this file, decided by asking it to.
 *
 * A hardcoded codec allow-list gets this wrong in both directions: Chromium's HEVC
 * support depends on the OS and hardware (macOS/Windows with a platform decoder can
 * play it, Linux usually can't), so the same build answers differently per machine.
 * Loading the real file is the only answer that is right everywhere, and it costs a
 * fraction of what transcoding a proxy unnecessarily would.
 *
 * Only metadata is requested, so this reads the file header rather than the whole file.
 *
 * `expectVideo` matters more than it looks: a file whose video stream cannot be decoded
 * but whose audio can (HEVC video + AAC audio, the usual game capture) still reaches
 * readyState 4 and fires no error at all — it just reports videoWidth 0 and renders
 * nothing. Checking for a real frame size is the only way to catch that case.
 */
export function canPreviewFile(filePath: string, expectVideo: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement('video')
    el.preload = 'metadata'
    el.muted = true

    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      el.onloadedmetadata = null
      el.onerror = null
      // Detach the source so the half-open decode is torn down instead of lingering.
      el.removeAttribute('src')
      el.load()
      resolve(result)
    }

    // A file that is merely slow (network drive, huge header) is treated as playable:
    // transcoding it would be even slower, and the preview surfaces a real decode
    // failure on its own if one happens later.
    const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS)

    el.onloadedmetadata = () => finish(!expectVideo || el.videoWidth > 0)
    el.onerror = () => finish(false)
    el.src = toFileUrl(filePath)
  })
}

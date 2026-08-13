import { previewSourcePath, toFileUrl } from './previewSource'
import type { MediaAsset } from '@shared/types'

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

/**
 * 並びのうち、**いまのままではプレビューできない**素材を返す。
 *
 * プロキシを作るのは取り込みのときだけだったので、変換が終わる前に保存する・変換が
 * 一度失敗する・別の環境で開く、のいずれでも**開き直した瞬間から再生できなくなり、
 * 誰も作り直さなかった**。開いたときにも同じ判定を通すために切り出してある。
 *
 * 見るのは**プレビューが実際に読む側**(`proxyPath ?? filePath`)。保存されていた
 * プロキシの実体が消えていることがあるので、`proxyPath` があるだけでは在るとみなさない。
 * 作り直しは呼び出し側が**元ファイル**から行う。
 *
 * 判定関数を引数で受け取るのは、実際に読み込ませる `canPreviewFile` が DOM を使うため
 * (試験では差し替える)。
 */
export async function assetsNeedingPreviewProxy(
  assets: readonly MediaAsset[],
  canPreview: (filePath: string, expectVideo: boolean) => Promise<boolean>
): Promise<MediaAsset[]> {
  const result: MediaAsset[] = []
  for (const asset of assets) {
    if (await canPreview(previewSourcePath(asset), asset.hasVideo)) continue
    result.push(asset)
  }
  return result
}

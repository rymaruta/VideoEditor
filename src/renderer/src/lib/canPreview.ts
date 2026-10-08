import { toFileUrl } from './previewSource'
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

/** 開いたプロジェクトの素材1つについて、プレビューのために何をするか */
export type LoadedPreviewPlan =
  /** いまのままで聞ける・見られる */
  | { kind: 'ok' }
  /** 元ファイルで再生できるが、保存されていたプロキシの実体が無い。プロキシの指定を外す */
  | { kind: 'clearProxy' }
  /** プロキシを作る(作るかどうかの最終判断は取り込みと同じ `ensurePreviewable`) */
  | { kind: 'build'; codecSaysUnplayable: boolean; audioNeedsFold: boolean }
  /** 再生できず、素材を調べることもできない(移動・削除された) */
  | { kind: 'probeFailed' }

/**
 * 開いた/復元したプロジェクトの素材に、プレビューのために何をするかを決める。
 *
 * プロキシを作るのは取り込みのときだけだったので、変換が終わる前に保存する・変換が
 * 一度失敗する・別の環境で開く、のいずれでも**開き直した瞬間から再生できなくなり、
 * 誰も作り直さなかった**。開いたときにも取り込みと同じ判定を通すために切り出してある。
 *
 * - プロキシで再生できれば何もしない(保存されていたプロキシの実体が消えていることが
 *   あるので、`proxyPath` があるだけでは在るとみなさない)
 * - 元ファイルで再生できても、4.0 の音声は試聴用の素材を作る(取り込み・差し替えと同じ。
 *   開いた経路だけ作らず、プレビューだけセンターが左に寄っていた)
 * - 元ファイルで再生できてプロキシの実体が無いなら、プロキシの指定を外す(外さないと
 *   プレビューは無いプロキシを読みにいき、再生できないままだった)
 *
 * 判定関数を引数で受け取るのは、実際に読み込ませる `canPreviewFile` が DOM を使うため
 * (試験では差し替える)。
 */
export async function planLoadedAssetPreview(
  asset: MediaAsset,
  canPreview: (filePath: string, expectVideo: boolean) => Promise<boolean>,
  probe: (
    filePath: string
  ) => Promise<{ needsPreviewProxy: boolean; previewAudioNeedsFold?: boolean }>
): Promise<LoadedPreviewPlan> {
  if (asset.proxyPath && (await canPreview(asset.proxyPath, asset.hasVideo))) return { kind: 'ok' }
  if (await canPreview(asset.filePath, asset.hasVideo)) {
    let audioNeedsFold = false
    if (asset.hasAudio) {
      try {
        audioNeedsFold = (await probe(asset.filePath)).previewAudioNeedsFold ?? false
      } catch {
        // 再生はできているので、調べられなくても元ファイルで聞かせる
      }
    }
    if (audioNeedsFold) return { kind: 'build', codecSaysUnplayable: false, audioNeedsFold }
    return asset.proxyPath ? { kind: 'clearProxy' } : { kind: 'ok' }
  }
  try {
    const meta = await probe(asset.filePath)
    return {
      kind: 'build',
      codecSaysUnplayable: meta.needsPreviewProxy,
      audioNeedsFold: meta.previewAudioNeedsFold ?? false
    }
  } catch {
    return { kind: 'probeFailed' }
  }
}

import { RgbHistogram, fitColorMatch, type ColorMatch } from '@shared/color/match'
import { pairedSamples } from '@shared/color/samples'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { MediaAsset } from '@shared/types'

/** 色の統計を取る画の大きさ(小さくても分布は変わらない) */
const FRAME = { w: 160, h: 90 }
/** 1台につき比べる時刻の数 */
const SAMPLES_PER_CAMERA = 8

export interface CameraColorResult {
  sourceId: string
  name: string
  /** 補正(差が無い・比べられなかったときは null) */
  match: ColorMatch | null
  /** 比べられた画の組の数 */
  pairs: number
}

/**
 * 基準カメラ以外のカメラを、基準カメラの色に合わせる補正を求める。
 * 返す `matches` は素材ごと(同じカメラの素材には同じ補正)。基準カメラの素材は補正を外す。
 */
export async function planCameraColors(
  info: MulticamInfo,
  assets: readonly MediaAsset[],
  onProgress?: (done: number, total: number) => void
): Promise<{ matches: Record<string, ColorMatch | undefined>; cameras: CameraColorResult[] }> {
  const pathOf = new Map(assets.map((a) => [a.id, a.filePath]))
  const cameras = info.sources.filter((s) => s.kind === 'camera')
  const plans = cameras
    .filter((c) => c.id !== info.anchorSourceId)
    .map((c) => ({ camera: c, samples: pairedSamples(info, c.id, SAMPLES_PER_CAMERA) }))
  const requests: { path: string; time: number }[] = []
  for (const p of plans)
    for (const s of p.samples)
      requests.push(
        { path: pathOf.get(s.file.assetId) ?? '', time: s.sourceTime },
        { path: pathOf.get(s.anchorFile.assetId) ?? '', time: s.anchorTime }
      )
  const off = onProgress ? window.api.onFramesProgress((p) => onProgress(p.done, p.total)) : null
  let frames: (Uint8Array | null)[]
  try {
    frames = requests.length > 0 ? await window.api.framesRgb(requests, FRAME) : []
  } finally {
    off?.()
  }

  const matches: Record<string, ColorMatch | undefined> = {}
  const results: CameraColorResult[] = []
  let k = 0
  for (const p of plans) {
    const src = new RgbHistogram()
    const ref = new RgbHistogram()
    let pairs = 0
    for (let i = 0; i < p.samples.length; i++, k += 2) {
      const a = frames[k]
      const b = frames[k + 1]
      // 片方しか読めなかった時刻は使わない(同じ時刻どうしで比べる)
      if (!a || !b) continue
      src.add(a)
      ref.add(b)
      pairs++
    }
    const match = pairs > 0 ? fitColorMatch(src, ref) : null
    results.push({ sourceId: p.camera.id, name: p.camera.name, match, pairs })
    for (const f of info.files)
      if (f.sourceId === p.camera.id) matches[f.assetId] = match ?? undefined
  }
  for (const f of info.files) if (f.sourceId === info.anchorSourceId) matches[f.assetId] = undefined
  return { matches, cameras: results }
}

import type { MediaAsset, TextOverlay } from '@shared/types'
import type { RoughCut } from '@shared/roughCut/build'
import { decideTelopPlacement } from '@shared/telop/avoidFaces'
import { textCanvasSize } from '@shared/resolution'
import type { AspectRatio } from '@shared/types'

/**
 * 発言テロップを、顔を隠さない位置へ(計画書 §5.8)。
 * テロップが出ている時間の真ん中の画(本編のそのクリップの素材)を取り出して顔を探し、
 * 下のテロップが顔に掛かるなら上へ、上も掛かるなら下のまま要確認にする。
 * 同じ画(素材と 0.5 秒単位の時刻)は1回だけ調べる。
 */

export interface PlacementResult {
  telops: Omit<TextOverlay, 'id'>[]
  moved: number
  review: { startTime: number; text: string }[]
  /** 画を調べられなかった枚数 */
  unchecked: number
}

/** 仮編集のタイムラインの時刻 → 本編の素材と、その素材の時刻 */
function frameAt(
  cut: RoughCut,
  assets: Map<string, MediaAsset>,
  t: number
): { asset: MediaAsset; time: number } | null {
  let cursor = 0
  for (const c of cut.main) {
    const dur = (c.outPoint - c.inPoint) / (c.speed || 1)
    if (t < cursor + dur) {
      const asset = assets.get(c.assetId)
      return asset && asset.hasVideo
        ? { asset, time: c.inPoint + (t - cursor) * (c.speed || 1) }
        : null
    }
    cursor += dur
  }
  return null
}

export async function placeTelopsAvoidingFaces(
  telops: Omit<TextOverlay, 'id'>[],
  cut: RoughCut,
  assetsList: MediaAsset[],
  aspect: AspectRatio,
  onProgress?: (done: number, total: number) => void
): Promise<PlacementResult> {
  const assets = new Map(assetsList.map((a) => [a.id, a]))
  const canvas = textCanvasSize(aspect)
  const keyOf = (path: string, time: number): string => `${path}|${Math.round(time * 2) / 2}`
  const requests: { path: string; time: number; width: number; height: number }[] = []
  const indexOf = new Map<string, number>()
  const telopKey: (string | null)[] = telops.map((o) => {
    if (o.style.position !== 'bottom' || o.style.customPosition) return null
    const f = frameAt(cut, assets, (o.startTime + o.endTime) / 2)
    if (!f) return null
    const key = keyOf(f.asset.filePath, f.time)
    if (!indexOf.has(key)) {
      indexOf.set(key, requests.length)
      requests.push({
        path: f.asset.filePath,
        time: f.time,
        width: f.asset.width,
        height: f.asset.height
      })
    }
    return key
  })
  if (requests.length === 0) return { telops, moved: 0, review: [], unchecked: 0 }
  const off = window.api.onFaceProgress(({ done, total }) => onProgress?.(done, total))
  let faces: Awaited<ReturnType<typeof window.api.faceDetect>>
  try {
    faces = await window.api.faceDetect(requests)
  } finally {
    off()
  }
  let moved = 0
  let unchecked = 0
  const review: PlacementResult['review'] = []
  const out = telops.map((o, i) => {
    const key = telopKey[i]
    if (!key) return o
    const found = faces[indexOf.get(key)!]
    if (found === null) {
      unchecked++
      return o
    }
    const decision = decideTelopPlacement(o, found, canvas)
    if (decision === 'moveTop') {
      moved++
      return { ...o, style: { ...o.style, position: 'top' as const } }
    }
    if (decision === 'review') review.push({ startTime: o.startTime, text: o.text })
    return o
  })
  return { telops: out, moved, review, unchecked }
}

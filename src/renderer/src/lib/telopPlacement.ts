import type { MediaAsset, TextOverlay } from '@shared/types'
import type { RoughCut } from '@shared/roughCut/build'
import {
  containRect,
  decideTelopPlacement,
  faceToCanvas,
  telopRect
} from '@shared/telop/avoidFaces'
import { detectHud, hudMapToCanvas, speechYAvoidingHud } from '@shared/telop/hud'
import { textCanvasSize } from '@shared/resolution'
import type { AspectRatio } from '@shared/types'
import { autoTelopKey } from '@shared/telop/manual'
import { stackSimultaneousTelops, stackedBottomTelops } from '@shared/telop/stack'

/**
 * 発言テロップを、顔を隠さない位置へ(計画書 §5.8)。
 * テロップが出ている時間の真ん中の画(本編のそのクリップの素材)を取り出して顔を探し、
 * 下のテロップが顔に掛かるなら上へ、上も掛かるなら下のまま要確認にする。
 * 同じ画(素材と 0.5 秒単位の時刻)は1回だけ調べる。
 */

export interface PlacementResult {
  telops: Omit<TextOverlay, 'id'>[]
  moved: number
  /** `key` は作り直しても変わらない、自動テロップの鍵(`autoTelopKey`)。時刻は作り直すと動く */
  review: { startTime: number; text: string; key: string | null }[]
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
    // 顔の枠は素材の絵の中の比。画面の比へ写してから比べる(縦長の企画に横長の録画を置くと上下に帯ができる)
    const req = requests[indexOf.get(key)!]
    const fit = containRect({ width: req.width, height: req.height }, canvas)
    const decision = decideTelopPlacement(
      o,
      found.map((f) => faceToCanvas(f, fit)),
      canvas
    )
    if (decision === 'moveTop') {
      moved++
      return { ...o, style: { ...o.style, position: 'top' as const } }
    }
    if (decision === 'review')
      review.push({ startTime: o.startTime, text: o.text, key: autoTelopKey(o) })
    return o
  })
  return { telops: out, moved, review, unchecked }
}

/** HUD を探すのに読む画の数と大きさ */
const HUD_SAMPLES = 24
const HUD_FRAME = { w: 160, h: 90 }

/**
 * ゲーム画面の動かない表示(HUD)を避けて、下の発言テロップを上へずらす(ゲーム実況)。
 * 本編のあちこちから画を読み、HUD を探す(`@shared/telop/hud`)。下の中央の帯が HUD に掛かるなら、
 * 掛からない高さへ全部の発言テロップをそろえて動かす(1枚ずつ高さが変わると読みにくい)
 */
export async function placeTelopsAvoidingHud(
  telops: Omit<TextOverlay, 'id'>[],
  cut: RoughCut,
  assetsList: MediaAsset[],
  aspect: AspectRatio
): Promise<{ telops: Omit<TextOverlay, 'id'>[]; moved: number; y: number | null }> {
  const assets = new Map(assetsList.map((a) => [a.id, a]))
  const total = cut.duration
  if (!(total > 0) || cut.main.length === 0) return { telops, moved: 0, y: null }
  const requests: { path: string; time: number }[] = []
  for (let k = 0; k < HUD_SAMPLES; k++) {
    const f = frameAt(cut, assets, ((k + 0.5) / HUD_SAMPLES) * total)
    if (f) requests.push({ path: f.asset.filePath, time: f.time })
  }
  const frames = (await window.api.framesRgb(requests, HUD_FRAME)).filter(
    (x): x is Uint8Array => x !== null
  )
  const found = detectHud(frames, HUD_FRAME.w, HUD_FRAME.h)
  if (!found) return { telops, moved: 0, y: null }
  const canvas = textCanvasSize(aspect)
  // HUD のマスは素材の絵の中の比。画面の比へ写す(縦長の企画に横長の録画を置くと上下に帯ができる)
  const first = cut.main.map((c) => assets.get(c.assetId)).find((a) => a?.hasVideo)
  const map = first
    ? hudMapToCanvas(found, containRect({ width: first.width, height: first.height }, canvas))
    : found
  // 既定の位置(下)の帯の中心。2行の発言テロップで見積もる
  const sample = telops.find((o) => o.style.position === 'bottom' && !o.style.customPosition)
  if (!sample) return { telops, moved: 0, y: null }
  const r = telopRect({ text: 'あ\nあ', style: sample.style }, canvas, 'bottom')
  const y = speechYAvoidingHud(map, r.y + r.h / 2)
  if (y === null) return { telops, moved: 0, y: null }
  // 段に積まれた発言テロップ(掛け合いで同時に出たもの)も、一番下の段ごとまとめて上げる
  // (下の段だけ上げると、上の段と重なり、上の段は HUD の近くに残る)。手で置いたものには触れない
  const managed = stackedBottomTelops(telops, canvas.h)
  const picked = telops
    .map((o, i) => ({ o, i }))
    .filter(({ i }) => managed[i])
    .map(({ o, i }) => {
      const { customPosition: _drop, ...style } = o.style
      void _drop
      return { o: { ...o, style }, i }
    })
  const restacked = stackSimultaneousTelops(
    picked.map((p) => p.o),
    canvas.h,
    { baseCenter: y }
  )
  const out = [...telops]
  picked.forEach((p, k) => {
    out[p.i] = restacked[k]
  })
  return { telops: out, moved: picked.length, y }
}

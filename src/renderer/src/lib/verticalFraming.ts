import {
  coversFace,
  faceToCanvas,
  telopRect,
  type FaceBox,
  type Rect
} from '@shared/telop/avoidFaces'
import { liftAboveShortsUi } from '@shared/telop/stack'
import { textCanvasSize } from '@shared/resolution'
import type { Clip, MediaAsset, Project, TextOverlay } from '@shared/types'

/**
 * 横長の録画を縦(9:16)で書き出すときの、絵の切り出し(ショート・リール)。
 *
 * 前は横の絵をそのまま縮めて上下を黒にしていたので、人物がとても小さかった(試し編集 第2回の縦ショート)。
 * 既定では、本編のクリップごとに顔(yunet。発言テロップの配置と同じ検出)を探し、縦の枠を人物に寄せて
 * 絵で埋める。2人が縦の枠に収まる間隔なら両方が入る位置、収まらなければ、よく映っている方(顔が大きく、
 * 多くの画で見つかる方)に寄せる。マイク1本の素材では誰が話しているかは分からないので、映り方で決める。
 * 顔が見つからなければ真ん中。
 *
 * 書き出しの時だけの写しに当てる(企画のクリップは変えない)。人がクリップに決めた切り抜き(枠を埋める・
 * 埋めない・切り取り位置)はそのまま使う。黒帯の形は設定(`verticalFraming = 'letterbox'`)で選べる。
 * 発言テロップは、切り出した絵の中で顔を避けて置き、Shorts の下の帯に隠れない高さへ上げる。
 */

/** 顔として使う確からしさの下限(テロップの配置と同じ) */
const MIN_SCORE = 0.7
/** 両方を入れるとき、縦の枠に対して顔の並びが占めてよい割合(枠の端に顔が切れないように) */
const BOTH_FIT_RATIO = 0.92
/** クリップの中で顔を探す位置(クリップの長さに対する割合) */
export const FRAMING_SAMPLES = [0.2, 0.5, 0.8] as const

/** 縦の枠が横長の絵のどれだけの幅を占めるか(1 以上なら切らない) */
export function windowFraction(source: { width: number; height: number }, aspect: number): number {
  if (!(source.width > 0 && source.height > 0)) return 1
  return aspect / (source.width / source.height)
}

interface FaceGroup {
  lo: number
  hi: number
  weight: number
}

/**
 * 顔の位置(クリップのいくつかの画で見つけた顔。素材の絵に対する比)から、縦の枠の真ん中(素材の比)を決める。
 * 顔が無ければ null
 */
export function framingCenter(
  samples: readonly (readonly FaceBox[] | null)[],
  fraction: number
): { x: number; y: number } | null {
  const faces = samples.flatMap((f) => f ?? []).filter((f) => f.score >= MIN_SCORE && f.w > 0)
  if (faces.length === 0) return null
  if (fraction >= 1) return { x: 0.5, y: 0.5 }
  // 横の位置の近い顔を同じ人とみなしてまとめる(画ごとに少し動く)
  const sorted = [...faces].sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2))
  const groups: FaceGroup[] = []
  for (const f of sorted) {
    const g = groups[groups.length - 1]
    const lo = f.x
    const hi = f.x + f.w
    if (g && lo <= g.hi + f.w * 0.5) {
      g.hi = Math.max(g.hi, hi)
      g.weight += f.w * f.h * f.score
    } else groups.push({ lo, hi, weight: f.w * f.h * f.score })
  }
  const lo = Math.min(...groups.map((g) => g.lo))
  const hi = Math.max(...groups.map((g) => g.hi))
  // 全員が縦の枠に収まるなら、全員が入る位置
  if (hi - lo <= fraction * BOTH_FIT_RATIO) return { x: (lo + hi) / 2, y: 0.5 }
  // 収まらなければ、いちばんよく映っている人(顔の大きさ×見つかった回数)に寄せる
  const main = groups.reduce((a, b) => (b.weight > a.weight ? b : a))
  return { x: (main.lo + main.hi) / 2, y: 0.5 }
}

/**
 * 枠を埋めて切り出した絵が、画面(キャンバス)のどこに来るか(画面の比。はみ出した分は 0 未満・1 超え)。
 * 書き出しの切り出し(`scaleToFrameFilter` の crop: 左上 = min(max(0, iw*cx - ow/2), iw-ow))と同じ位置
 */
export function coverRect(
  source: { width: number; height: number },
  canvas: { w: number; h: number },
  center: { x: number; y: number }
): Rect {
  if (!(source.width > 0 && source.height > 0)) return { x: 0, y: 0, w: 1, h: 1 }
  const s = Math.max(canvas.w / source.width, canvas.h / source.height)
  const w = (source.width * s) / canvas.w
  const h = (source.height * s) / canvas.h
  const left = Math.min(Math.max(0, w * center.x - 0.5), w - 1)
  const top = Math.min(Math.max(0, h * center.y - 0.5), h - 1)
  return { x: -left, y: -top, w, h }
}

/** 縦の枠を絵で埋める対象のクリップか(人が枠の埋め方を決めていない、横長の映像) */
export function fillsVertical(clip: Clip, asset: MediaAsset | undefined, aspect: number): boolean {
  if (clip.fillCrop !== undefined) return false
  if (!asset || asset.hasVideo === false || asset.still) return false
  return windowFraction(asset, aspect) < 1
}

/** タイムラインの区間 [a, b) に掛かる本編のクリップと、その頭の時刻 */
export function clipsInRange(
  clips: readonly Clip[],
  range?: { start: number; end: number }
): { clip: Clip; start: number; end: number }[] {
  let t = 0
  const out: { clip: Clip; start: number; end: number }[] = []
  for (const c of clips) {
    const d = (c.outPoint - c.inPoint) / (c.speed || 1)
    if (!range || (t < range.end && t + d > range.start))
      out.push({ clip: c, start: t, end: t + d })
    t += d
  }
  return out
}

export interface VerticalFillResult {
  project: Project
  /** 絵で埋めた(切り出した)クリップの数 */
  filled: number
  /** 顔に寄せたクリップの数 */
  onFaces: number
  /** 顔を避けて上へ移した発言テロップの数 */
  movedTelops: number
}

/**
 * 縦の書き出し用の写しを作る(企画は変えない)。`faces` はクリップの id → `FRAMING_SAMPLES` の位置の画で
 * 見つけた顔(読めなかった画は null)。無いクリップは真ん中で切り出す
 */
export function applyVerticalFill(
  project: Project,
  faces: ReadonlyMap<string, readonly (readonly FaceBox[] | null)[]>,
  range?: { start: number; end: number }
): VerticalFillResult {
  const canvas = textCanvasSize('9:16')
  const aspect = canvas.w / canvas.h
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  const inRange = new Set(clipsInRange(project.clips, range).map((x) => x.clip.id))
  let filled = 0
  let onFaces = 0
  const clips = project.clips.map((c) => {
    const asset = assets.get(c.assetId)
    if (!inRange.has(c.id) || !fillsVertical(c, asset, aspect)) return c
    filled++
    const center = c.cropCenter
      ? null
      : framingCenter(faces.get(c.id) ?? [], windowFraction(asset!, aspect))
    if (center) onFaces++
    return { ...c, fillCrop: true, cropCenter: c.cropCenter ?? center ?? { x: 0.5, y: 0.5 } }
  })
  if (filled === 0) return { project, filled, onFaces, movedTelops: 0 }

  // 発言テロップ: Shorts の下の帯に隠れない高さへ上げ、切り出した絵の顔に掛かるなら上へ
  const placed = clipsInRange(clips)
  const faceAt = (t: number): FaceBox[] => {
    const p = placed.find((x) => t >= x.start && t < x.end)
    if (!p || !p.clip.fillCrop || !p.clip.cropCenter) return []
    const asset = assets.get(p.clip.assetId)
    const found = faces.get(p.clip.id)
    if (!asset || !found) return []
    // 時刻にいちばん近い画の顔
    const r = (t - p.start) / Math.max(1e-6, p.end - p.start)
    let best = -1
    FRAMING_SAMPLES.forEach((s, i) => {
      if (found[i] && (best < 0 || Math.abs(s - r) < Math.abs(FRAMING_SAMPLES[best] - r))) best = i
    })
    if (best < 0) return []
    const fit = coverRect(asset, canvas, p.clip.cropCenter)
    return found[best]!.map((f) => faceToCanvas(f, fit))
  }
  const speech = (o: TextOverlay): boolean =>
    Boolean(o.utteranceId) && !o.edited && o.style.position === 'bottom' && !o.style.customPosition
  const lifted = liftAboveShortsUi(project.textOverlays, canvas.h, { canvasW: canvas.w })
  let movedTelops = 0
  const textOverlays = project.textOverlays.map((o, i) => {
    if (!speech(o)) return o
    if (range && (o.endTime <= range.start || o.startTime >= range.end)) return o
    const faceList = faceAt((o.startTime + o.endTime) / 2)
    const up = lifted[i]
    const pos = up.style.customPosition
    const bottomRect = telopRect(up, canvas, 'bottom')
    const rect = pos ? { ...bottomRect, y: pos.y - bottomRect.h / 2 } : bottomRect
    if (faceList.length > 0 && coversFace(rect, faceList)) {
      if (!coversFace(telopRect(o, canvas, 'top'), faceList)) {
        movedTelops++
        return { ...o, style: { ...o.style, position: 'top' as const } }
      }
    }
    return up
  })
  return { project: { ...project, clips, textOverlays }, filled, onFaces, movedTelops }
}

/**
 * 縦の書き出し用の写しを、顔を探してから作る。顔を探せなかった(検出が止まった)ときは、真ん中で切り出す
 */
export async function prepareVerticalFill(
  project: Project,
  range?: { start: number; end: number },
  onProgress?: (done: number, total: number) => void
): Promise<VerticalFillResult> {
  const aspect = textCanvasSize('9:16').w / textCanvasSize('9:16').h
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  const requests: { path: string; time: number; width: number; height: number }[] = []
  const indexOf = new Map<string, number>()
  const plan = new Map<string, number[]>()
  for (const { clip } of clipsInRange(project.clips, range)) {
    const asset = assets.get(clip.assetId)
    if (!asset || !fillsVertical(clip, asset, aspect) || clip.cropCenter) continue
    const idx = FRAMING_SAMPLES.map((s) => {
      const time = clip.inPoint + (clip.outPoint - clip.inPoint) * s
      const key = `${asset.filePath}|${Math.round(time * 2) / 2}`
      if (!indexOf.has(key)) {
        indexOf.set(key, requests.length)
        requests.push({ path: asset.filePath, time, width: asset.width, height: asset.height })
      }
      return indexOf.get(key)!
    })
    plan.set(clip.id, idx)
  }
  let found: (FaceBox[] | null)[] = []
  if (requests.length > 0) {
    const off = window.api.onFaceProgress(({ done, total }) => onProgress?.(done, total))
    try {
      found = (await window.api.faceDetect(requests)) ?? []
    } catch {
      found = []
    } finally {
      off()
    }
  }
  const faces = new Map<string, (FaceBox[] | null)[]>()
  for (const [id, idx] of plan)
    faces.set(
      id,
      idx.map((i) => found[i] ?? null)
    )
  return applyVerticalFill(project, faces, range)
}

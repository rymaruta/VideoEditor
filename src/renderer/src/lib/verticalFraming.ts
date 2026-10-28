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

/** 顔を探す画の数の上限(全体)。数百〜2000本の仮編集でも、探す画はこれまで(素材ごとに代表の画で決める) */
export const MAX_FACE_FRAMES = 48
/** 素材ごとの代表の画の数の上限・下限 */
const MAX_PER_ASSET = 12
const MIN_PER_ASSET = 2
/** 代表の画の間隔の下限(素材の秒)。カメラの画角は近い時刻ならほぼ同じなので、近いクリップは同じ画で決める */
const MIN_SAMPLE_GAP_SEC = 20
/** 1回に探す画の数(この間ごとに進み具合を出し、中止を確かめる) */
const FACE_BATCH = 6

/** 顔を探した画(素材の秒)と、見つけた顔(読めなかった画は null) */
export interface FaceSample {
  time: number
  faces: FaceBox[] | null
}

export interface VerticalFillOptions {
  /** タイムラインの区間だけ(範囲の書き出し) */
  range?: { start: number; end: number }
  /**
   * 自動のショート: 組み立てが真ん中で埋めた(枠を埋める・切り取り位置なし)クリップも顔に寄せる
   * (人が決めた切り抜きと区別が付かないので、自動のショートを作るときだけ)
   */
  refineAutoFill?: boolean
  /** 埋めるクリップが無くても、発言テロップを Shorts の下の帯に隠れない高さへ上げる(自動のショート) */
  alwaysLift?: boolean
}

/**
 * 縦の枠を顔に寄せて絵で埋める対象のクリップか。人が見え方を決めたクリップ(枠を埋める・埋めない、
 * ぼかし背景の入り切り)は触らない。静止画・縦の素材・音だけの素材も対象外
 */
export function fillsVertical(
  clip: Clip,
  asset: MediaAsset | undefined,
  aspect: number,
  refineAutoFill = false
): boolean {
  if (clip.blurBackground !== undefined) return false
  if (clip.fillCrop !== undefined && !(refineAutoFill && clip.fillCrop && !clip.cropCenter))
    return false
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

const ASPECT = textCanvasSize('9:16').w / textCanvasSize('9:16').h

/**
 * 縦の書き出し用の写しを作る(企画は変えない)。`faces` はクリップの id → そのクリップの近くで顔を探した画。
 * 無いクリップは真ん中で切り出す
 */
export function applyVerticalFill(
  project: Project,
  faces: ReadonlyMap<string, readonly FaceSample[]>,
  options: VerticalFillOptions = {}
): VerticalFillResult {
  const { range } = options
  const canvas = textCanvasSize('9:16')
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  const inRange = new Set(clipsInRange(project.clips, range).map((x) => x.clip.id))
  let filled = 0
  let onFaces = 0
  const clips = project.clips.map((c) => {
    const asset = assets.get(c.assetId)
    if (!inRange.has(c.id) || !fillsVertical(c, asset, ASPECT, options.refineAutoFill)) return c
    filled++
    const center = c.cropCenter
      ? null
      : framingCenter(
          (faces.get(c.id) ?? []).map((s) => s.faces),
          windowFraction(asset!, ASPECT)
        )
    if (center) onFaces++
    return { ...c, fillCrop: true, cropCenter: c.cropCenter ?? center ?? { x: 0.5, y: 0.5 } }
  })
  if (filled === 0 && !options.alwaysLift) return { project, filled, onFaces, movedTelops: 0 }

  // 発言テロップ: Shorts の下の帯に隠れない高さへ上げ、切り出した絵の顔に掛かるなら上へ
  const placed = clipsInRange(clips)
  const faceAt = (t: number): FaceBox[] => {
    const p = placed.find((x) => t >= x.start && t < x.end)
    if (!p || !p.clip.fillCrop || !p.clip.cropCenter) return []
    const asset = assets.get(p.clip.assetId)
    const found = (faces.get(p.clip.id) ?? []).filter((s) => s.faces !== null)
    if (!asset || found.length === 0) return []
    // その時刻(素材の秒)にいちばん近い画の顔
    const src = p.clip.inPoint + (t - p.start) * (p.clip.speed || 1)
    const near = found.reduce((a, b) => (Math.abs(b.time - src) < Math.abs(a.time - src) ? b : a))
    const fit = coverRect(asset, canvas, p.clip.cropCenter)
    return near.faces!.map((f) => faceToCanvas(f, fit))
  }
  // 位置を手で決めた枚(自由配置)・下以外の枚は動かさない。文字だけ直した枚は、前後の枚と同じく上げる
  // (直した枚だけが下の帯の高さに残り、前後の枚と高さが跳んでいた)
  const speech = (o: TextOverlay): boolean =>
    Boolean(o.utteranceId) && o.style.position === 'bottom' && !o.style.customPosition
  const lifted = liftAboveShortsUi(project.textOverlays, canvas.h, { canvasW: canvas.w })
  let movedTelops = 0
  const textOverlays = project.textOverlays.map((o, i) => {
    // 自動のショートは、組み立てが上げていた枚(下のテロップ全部)を今までどおり上げる
    if (!speech(o)) return options.alwaysLift ? lifted[i] : o
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

/** 顔を探す画の計画: 探す画と、クリップごとに使う画の番号 */
export interface FacePlan {
  requests: { path: string; time: number; width: number; height: number }[]
  perClip: Map<string, number[]>
}

/**
 * 顔を探す画を決める。クリップごとに探すと、数百〜2000本の仮編集で数千回 ffmpeg を起こしていた。
 * 顔の位置はカメラ(素材)ごとにほぼ一定なので、素材ごとに代表の画(クリップの真ん中の時刻を
 * `MIN_SAMPLE_GAP_SEC` 以上の間隔でまとめたもの。全体で `MAX_FACE_FRAMES` まで)だけを探し、
 * クリップは近い代表の画(3枚まで)で決める
 */
export function planFaceFrames(project: Project, options: VerticalFillOptions = {}): FacePlan {
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  const byAsset = new Map<string, { id: string; mid: number }[]>()
  for (const { clip } of clipsInRange(project.clips, options.range)) {
    const asset = assets.get(clip.assetId)
    if (!fillsVertical(clip, asset, ASPECT, options.refineAutoFill) || clip.cropCenter) continue
    const list = byAsset.get(clip.assetId) ?? []
    list.push({ id: clip.id, mid: (clip.inPoint + clip.outPoint) / 2 })
    byAsset.set(clip.assetId, list)
  }
  const requests: FacePlan['requests'] = []
  const perClip = new Map<string, number[]>()
  const perAsset = Math.max(
    MIN_PER_ASSET,
    Math.min(MAX_PER_ASSET, Math.floor(MAX_FACE_FRAMES / Math.max(1, byAsset.size)))
  )
  for (const [assetId, list] of byAsset) {
    const asset = assets.get(assetId)!
    const mids = list.map((x) => x.mid).sort((a, b) => a - b)
    const span = mids[mids.length - 1] - mids[0]
    const gap = Math.max(MIN_SAMPLE_GAP_SEC, span / Math.max(1, perAsset - 1))
    const times: number[] = []
    for (const m of mids)
      if (times.length === 0 || m - times[times.length - 1] >= gap) times.push(m)
    const base = requests.length
    for (const time of times)
      requests.push({ path: asset.filePath, time, width: asset.width, height: asset.height })
    for (const c of list) {
      const near = times
        .map((t, i) => ({ i, d: Math.abs(t - c.mid) }))
        .sort((a, b) => a.d - b.d)
        .filter((x, k) => k === 0 || x.d <= gap * 1.5)
        .slice(0, 3)
        .map((x) => base + x.i)
      perClip.set(c.id, near)
    }
  }
  return { requests, perClip }
}

/**
 * 顔を探す(`FACE_BATCH` 枚ずつ。その間ごとに進み具合を出し、中止を確かめる)。中止は `EXPORT_CANCELED`。
 * 探せなかった画は null
 */
export async function detectFaceFrames(
  requests: FacePlan['requests'],
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<(FaceBox[] | null)[]> {
  const out: (FaceBox[] | null)[] = []
  options.onProgress?.(0, requests.length)
  for (let i = 0; i < requests.length; i += FACE_BATCH) {
    if (options.signal?.aborted) throw new Error('EXPORT_CANCELED')
    const batch = requests.slice(i, i + FACE_BATCH)
    let found: (FaceBox[] | null)[] = []
    try {
      found = (await window.api.faceDetect(batch)) ?? []
    } catch {
      found = []
    }
    for (let k = 0; k < batch.length; k++) out.push(found[k] ?? null)
    options.onProgress?.(out.length, requests.length)
  }
  if (options.signal?.aborted) throw new Error('EXPORT_CANCELED')
  return out
}

/**
 * 縦の書き出し用の写しを、顔を探してから作る。顔を探せなかった(検出が止まった)画は無いものとして、
 * 真ん中で切り出す
 */
export async function prepareVerticalFill(
  project: Project,
  options: VerticalFillOptions & {
    signal?: AbortSignal
    onProgress?: (done: number, total: number) => void
  } = {}
): Promise<VerticalFillResult> {
  const plan = planFaceFrames(project, options)
  const found = await detectFaceFrames(plan.requests, options)
  const faces = new Map<string, FaceSample[]>()
  for (const [id, idx] of plan.perClip)
    faces.set(
      id,
      idx.map((i) => ({ time: plan.requests[i].time, faces: found[i] ?? null }))
    )
  return applyVerticalFill(project, faces, options)
}

/** 縦の書き出しで、顔に寄せて切り出すか(ゲーム実況はゲーム画面の真ん中のまま) */
export function framesOnFaces(project: Project): boolean {
  return project.autoEdit?.kind !== 'game'
}

/** 書き出し画面の、縦の画の見本の1コマ */
export interface VerticalSample {
  at: number
  filePath: string
  /** 素材の秒 */
  time: number
  still: boolean
  /** 素材の縦横比 */
  sourceAspect: number
  /** 枠を埋めて切り出す(false は黒帯で収める) */
  fill: boolean
  center: { x: number; y: number }
}

/**
 * 書き出し画面に出す、縦の画の見本(タイムラインの `times` の所)。書き出しと同じ決め方で切り出す
 * (顔に寄せるのは、書き出しで顔に寄せる設定のとき)
 */
export async function verticalSamples(
  project: Project,
  times: readonly number[],
  onFaces: boolean,
  signal?: AbortSignal
): Promise<VerticalSample[]> {
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  const placed = clipsInRange(project.clips)
  const picks = times
    .map((at) => ({ at, p: placed.find((x) => at >= x.start && at < x.end) }))
    .filter((x): x is { at: number; p: (typeof placed)[number] } => x.p !== undefined)
  const wanted = picks.map(({ at, p }) => {
    const asset = assets.get(p.clip.assetId)
    const time = asset?.still ? 0 : p.clip.inPoint + (at - p.start) * (p.clip.speed || 1)
    const auto = onFaces && fillsVertical(p.clip, asset, ASPECT)
    return { at, p, asset, time, auto }
  })
  const requests = wanted
    .filter((w) => w.auto && !w.p.clip.cropCenter)
    .map((w) => ({
      path: w.asset!.filePath,
      time: w.time,
      width: w.asset!.width,
      height: w.asset!.height
    }))
  const found = await detectFaceFrames(requests, { signal })
  let k = 0
  return wanted
    .filter((w) => w.asset)
    .map((w) => {
      const asset = w.asset!
      let center = w.p.clip.cropCenter ?? { x: 0.5, y: 0.5 }
      if (w.auto && !w.p.clip.cropCenter)
        center = framingCenter([found[k++] ?? null], windowFraction(asset, ASPECT)) ?? center
      return {
        at: w.at,
        filePath: asset.filePath,
        time: w.time,
        still: Boolean(asset.still),
        sourceAspect: asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 16 / 9,
        fill: w.auto || w.p.clip.fillCrop === true,
        center
      }
    })
}

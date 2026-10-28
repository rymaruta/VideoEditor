import {
  coversFace,
  faceToCanvas,
  telopRect,
  type FaceBox,
  type Rect
} from '@shared/telop/avoidFaces'
import { liftAboveShortsUi, SHORTS_TELOP_BOTTOM } from '@shared/telop/stack'
import { textCanvasSize } from '@shared/resolution'
import { computeMainTrackLayout } from '@shared/mainTrackLayout'
import { frameCountForDuration, projectFrameRate } from '@shared/frameRate'
import { stackTopHeight, type CropWindow, type StackSplit } from '@shared/videoFrame'
import type { Clip, MediaAsset, Project, TextOverlay } from '@shared/types'
import type { EpisodeKind } from '@shared/structure/kind'
import { placedUtterances } from './transcriptTimeline'

/**
 * 横長の録画を縦(9:16)で書き出すときの、絵の切り出し(ショート・リール)。
 *
 * 前は横の絵をそのまま縮めて上下を黒にしていたので、人物がとても小さかった(試し編集 第2回の縦ショート)。
 * 既定では、本編のクリップごとに顔(yunet。発言テロップの配置と同じ検出)を探し、縦の枠を人物に寄せて
 * 絵で埋める。
 * - 1人しか映らない・2人が縦の枠に収まる間隔なら、その人(両方)が入る位置で切り出す
 * - 2人が離れて映り縦の枠に収まらないとき(対談・車座の対話)は、縦のショートの定番に合わせて
 *   (a) 2人を上下に積む(上に左の人・下に右の人。それぞれ顔に寄せて切り出す)。マイク1本で誰が話して
 *   いるか分からない回はこれ。
 *   (b) 話者が分かれている回(複数マイク・話者分離)で、話者と顔の対応が口の動きで確かめられたときは、
 *   話している人の顔へ発話ごとに切り替える(切り替えは発話の頭。`MIN_SHOT_SEC` より短い切り替えはしない)。
 *   前は範囲の間ずっとよく映っている1人だけを映し、質問している人が一度も映らなかった(試し編集 第3回)
 * - 顔が見つからなければ真ん中
 * 設定で「1人に寄せる」(前の形)・「上下に黒帯」も選べる。
 *
 * 書き出しの時だけの写しに当てる(企画のクリップは変えない)。人がクリップに決めた切り抜き(枠を埋める・
 * 埋めない・切り取り位置)はそのまま使う。
 * 発言テロップは、切り出した絵の中で顔を避けて置き、Shorts の下の帯に隠れない高さへ上げる。上下に積んだ
 * 所では、上下の境目にも掛けない。
 */

/** 顔として使う確からしさの下限(テロップの配置と同じ) */
const MIN_SCORE = 0.7
/** 両方を入れるとき、縦の枠に対して顔の並びが占めてよい割合(枠の端に顔が切れないように) */
const BOTH_FIT_RATIO = 0.92
/** 2人目として数える顔の重さ(大きさ×見つかった回数)の下限(1人目に対する比)。背景の小さな顔は数えない */
const SECOND_PERSON_MIN_WEIGHT = 0.2
/** 上下に積むとき、段の窓の幅は顔の幅の何倍か(胸から上が入る) */
const FACE_ZOOM = 3.4
/** 段の窓の幅の下限(素材の幅に対する比。小さな顔を拡大しすぎない) */
const MIN_WINDOW_W = 0.2
/**
 * 段の窓の中で、顔の真ん中を置く高さ(上からの比)。頭の上を少し空け、下の段では顔の下に発言テロップ
 * (Shorts の下の帯より上)が入る余地を残す
 */
const FACE_Y_IN_WINDOW = 0.36
/** 同じ人の発話を1つの番としてまとめる間(秒) */
const RUN_JOIN_SEC = 2.5
/** 話者の切り替えの、1ショットの長さの下限(秒)。これより短くなる切り替えはしない */
export const MIN_SHOT_SEC = 2
/** 上下に積んだ所の境目の上下に、テロップを置かない幅(画面の高さに対する比) */
const SEAM_MARGIN = 0.012

/** 縦の枠が横長の絵のどれだけの幅を占めるか(1 以上なら切らない) */
export function windowFraction(source: { width: number; height: number }, aspect: number): number {
  if (!(source.width > 0 && source.height > 0)) return 1
  return aspect / (source.width / source.height)
}

/** 横の位置の近い顔をまとめた、1人ぶんの顔(素材の比)。重さは顔の大きさ×確からしさの合計 */
export interface FaceGroup {
  lo: number
  hi: number
  weight: number
  /** 顔の真ん中と大きさ(重さで平均) */
  cx: number
  cy: number
  w: number
  h: number
}

/** 顔をまとめて人ごとにする(横の位置の近い顔を同じ人とみなす。画ごとに少し動く) */
export function faceGroups(samples: readonly (readonly FaceBox[] | null)[]): FaceGroup[] {
  const faces = samples.flatMap((f) => f ?? []).filter((f) => f.score >= MIN_SCORE && f.w > 0)
  const sorted = [...faces].sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2))
  const groups: (FaceGroup & { sx: number; sy: number; sw: number; sh: number })[] = []
  for (const f of sorted) {
    const g = groups[groups.length - 1]
    const lo = f.x
    const hi = f.x + f.w
    const wt = f.w * f.h * f.score
    if (g && lo <= g.hi + f.w * 0.5) {
      g.hi = Math.max(g.hi, hi)
      g.weight += wt
      g.sx += (f.x + f.w / 2) * wt
      g.sy += (f.y + f.h / 2) * wt
      g.sw += f.w * wt
      g.sh += f.h * wt
    } else
      groups.push({
        lo,
        hi,
        weight: wt,
        cx: 0,
        cy: 0,
        w: 0,
        h: 0,
        sx: (f.x + f.w / 2) * wt,
        sy: (f.y + f.h / 2) * wt,
        sw: f.w * wt,
        sh: f.h * wt
      })
  }
  return groups.map(({ sx, sy, sw, sh, ...g }) => ({
    ...g,
    cx: sx / g.weight,
    cy: sy / g.weight,
    w: sw / g.weight,
    h: sh / g.weight
  }))
}

/**
 * 顔の位置(クリップのいくつかの画で見つけた顔。素材の絵に対する比)から、縦の枠の真ん中(素材の比)を決める。
 * 1人に寄せる決め方(2人が収まらなければ、よく映っている方)。顔が無ければ null
 */
export function framingCenter(
  samples: readonly (readonly FaceBox[] | null)[],
  fraction: number
): { x: number; y: number } | null {
  const groups = faceGroups(samples)
  if (groups.length === 0) return null
  if (fraction >= 1) return { x: 0.5, y: 0.5 }
  const lo = Math.min(...groups.map((g) => g.lo))
  const hi = Math.max(...groups.map((g) => g.hi))
  // 全員が縦の枠に収まるなら、全員が入る位置
  if (hi - lo <= fraction * BOTH_FIT_RATIO) return { x: (lo + hi) / 2, y: 0.5 }
  // 収まらなければ、いちばんよく映っている人(顔の大きさ×見つかった回数)に寄せる
  const main = groups.reduce((a, b) => (b.weight > a.weight ? b : a))
  return { x: (main.lo + main.hi) / 2, y: 0.5 }
}

/**
 * 上下に積む段の、1人ぶんの窓(素材の比)。窓の縦横比は出力の半分(9:16 なら 9:8)。顔の幅の `FACE_ZOOM` 倍の
 * 幅で、顔を窓の横の真ん中・上から `FACE_Y_IN_WINDOW` の高さに置く(素材からはみ出さない所まで)
 */
export function faceWindow(
  g: Pick<FaceGroup, 'cx' | 'cy' | 'w'>,
  source: { width: number; height: number },
  aspect: number
): CropWindow {
  const srcAspect = source.width > 0 && source.height > 0 ? source.width / source.height : 16 / 9
  const half = aspect * 2
  const maxW = Math.min(1, half / srcAspect)
  const w = Math.min(maxW, Math.max(MIN_WINDOW_W, g.w * FACE_ZOOM))
  const h = Math.min(1, (w * srcAspect) / half)
  const x = Math.min(1 - w, Math.max(0, g.cx - w / 2))
  const y = Math.min(1 - h, Math.max(0, g.cy - h * FACE_Y_IN_WINDOW))
  return { x, y, w, h }
}

/** クリップの切り出し方 */
export type Framing =
  | { kind: 'single'; center: { x: number; y: number } }
  /** 2人を上下に積む。`people` は上・下の人(左・右の順) */
  | { kind: 'stack'; split: StackSplit; people: [FaceGroup, FaceGroup] }

/**
 * クリップの切り出し方を決める。1人・2人が収まる → その位置の1枚。2人が離れていて収まらない → 上下に積む
 * (`twoPeople` が false なら、前と同じく1人に寄せる)。顔が無ければ null
 */
export function decideFraming(
  samples: readonly (readonly FaceBox[] | null)[],
  source: { width: number; height: number },
  aspect: number,
  twoPeople = true
): Framing | null {
  const groups = faceGroups(samples)
  if (groups.length === 0) return null
  const fraction = windowFraction(source, aspect)
  const single = framingCenter(samples, fraction)!
  if (fraction >= 1 || !twoPeople || groups.length < 2) return { kind: 'single', center: single }
  const lo = Math.min(...groups.map((g) => g.lo))
  const hi = Math.max(...groups.map((g) => g.hi))
  if (hi - lo <= fraction * BOTH_FIT_RATIO) return { kind: 'single', center: single }
  const ranked = [...groups].sort((a, b) => b.weight - a.weight)
  if (ranked[1].weight < ranked[0].weight * SECOND_PERSON_MIN_WEIGHT)
    return { kind: 'single', center: single }
  const pair = [ranked[0], ranked[1]].sort((a, b) => a.cx - b.cx) as [FaceGroup, FaceGroup]
  // よく映る2人だけなら収まる(3人目が離れているだけ)なら、2人が入る位置の1枚
  const pLo = Math.min(pair[0].lo, pair[1].lo)
  const pHi = Math.max(pair[0].hi, pair[1].hi)
  if (pHi - pLo <= fraction * BOTH_FIT_RATIO)
    return { kind: 'single', center: { x: (pLo + pHi) / 2, y: 0.5 } }
  return {
    kind: 'stack',
    split: {
      top: faceWindow(pair[0], source, aspect),
      bottom: faceWindow(pair[1], source, aspect)
    },
    people: pair
  }
}

/**
 * 上下に積んだ絵の中の顔の位置(画面の比)。窓の中に入る顔だけ(上の段・下の段の両方に入る顔は両方に)
 */
export function stackFacesOnCanvas(
  faces: readonly FaceBox[],
  split: StackSplit,
  canvasH: number
): FaceBox[] {
  const topFrac = stackTopHeight(canvasH) / canvasH
  const out: FaceBox[] = []
  const place = (win: CropWindow, y0: number, hFrac: number): void => {
    for (const f of faces) {
      const x = (f.x - win.x) / win.w
      const y = (f.y - win.y) / win.h
      const w = f.w / win.w
      const h = f.h / win.h
      if (x + w <= 0 || x >= 1 || y + h <= 0 || y >= 1) continue
      out.push({ ...f, x, y: y0 + y * hFrac, w, h: h * hFrac })
    }
  }
  place(split.top, 0, topFrac)
  place(split.bottom, topFrac, 1 - topFrac)
  return out
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
  /**
   * 2人が縦の枠に収まらないとき、上下に積む・話している人へ切り替える(既定)。false は前と同じく
   * よく映っている1人に寄せる(書き出しの画面の「1人に寄せる」)
   */
  twoPeople?: boolean
  /**
   * 話者と顔の対応(`findSpeakerFaces`)。あれば、2人が収まらない所は話している人の顔へ発話ごとに切り替える。
   * 無ければ(マイク1本・対応が確かめられない)上下に積む
   */
  speakers?: SpeakerFaces | null
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

/**
 * 上下に積む形・話す人の切り替えで分けたクリップを、元の形に戻した写し(企画は変えない)。自動のショートで
 * 保存した企画には、積む形(`splitStack`)と分けたクリップ(`<id>~v<n>`)が残る。書き出しの画面で「1人に
 * 寄せる」「黒帯」を選んだとき・縦でない(16:9 にした)ときに、積んだまま・分けたまま書き出していた
 * (監査の指摘 3)。分けたクリップは、続いている(同じ素材・同じ速さで、素材の位置が続く)ものだけ戻す
 */
/**
 * 分けたクリップどうしの設定が同じか(位置・id・切り抜きの位置・頭の繋ぎ・積む形のほか全部)。音を分けた・
 * ぼかし背景・色ラベルなど、人が片方だけ変えた所があればつながない(つなぐと2本目の設定が消え、音を分けた
 * 片方だけで声が二重・無音になった)。切り抜きの位置は話す人ごとに違うのが分けた理由なので比べない
 * (つないだクリップは1本目の位置)
 */
function sameClipSettings(a: Clip, b: Clip): boolean {
  const skip = new Set(['id', 'inPoint', 'outPoint', 'cropCenter', 'transitionIn', 'splitStack'])
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !skip.has(k)))
  for (const k of keys) {
    const x = (a as unknown as Record<string, unknown>)[k]
    const y = (b as unknown as Record<string, unknown>)[k]
    if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) return false
  }
  return true
}

export function withoutVerticalSplits(project: Project): Project {
  if (!project.clips.some((c) => c.splitStack || c.id.includes('~v'))) return project
  const out: Clip[] = []
  for (const c of project.clips) {
    const prev = out[out.length - 1]
    const base = c.id.replace(/~v\d+$/, '')
    if (
      prev &&
      base !== c.id &&
      prev.id === base &&
      !c.transitionIn &&
      sameClipSettings(prev, c) &&
      Math.abs(prev.outPoint - c.inPoint) < 1e-6
    ) {
      out[out.length - 1] = { ...prev, outPoint: c.outPoint }
      continue
    }
    if (c.splitStack) {
      const plain = { ...c }
      delete plain.splitStack
      out.push(plain)
    } else out.push(c)
  }
  return { ...project, clips: out }
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
  /** 2人を上下に積んだクリップの数 */
  stacked: number
  /** 話している人へ切り替えたクリップの数(切り替えで分けた後のショートの数ではない) */
  switched: number
}

const ASPECT = textCanvasSize('9:16').w / textCanvasSize('9:16').h

/** タイムラインの発話(話者のあるもの) */
export interface SpeakerLine {
  speaker: string
  start: number
  end: number
  /**
   * 別の人の声と重なっている所がある(話者の区間に 0.25 秒以上の重なりがあると区間全体に付く)。
   * 切り替えには使う(相づちが重なった長い答えを丸ごと捨てると、答える人へ切り替わらなかった)。
   * 口の動きを測るのには、重なりの無い発話を先に使う
   */
  overlap?: boolean
}

/** 話者と顔の対応(素材ごと。話者 → 顔の横の真ん中(素材の比))と、タイムラインの発話 */
export interface SpeakerFaces {
  faces: Map<string, Map<string, number>>
  lines: SpeakerLine[]
}

/**
 * 話している人のショート(クリップのタイムラインの区間 [start, end) の中)。切り替えは、別の人の発話の頭だけ。
 * 切り替えた後・前のショートが `minShot` 秒より短くなる切り替えと、`minShot` 秒より短い相づち(別の人の
 * 発話がすぐ戻る)では切り替えない。`keyOf` が null の話者(顔の分からない人)では切り替えない。
 * どの発話も分からなければ空
 */
export function speakerShots(
  lines: readonly SpeakerLine[],
  start: number,
  end: number,
  keyOf: (speaker: string) => number | null,
  minShot = MIN_SHOT_SEC
): { start: number; end: number; key: number }[] {
  const inside = lines
    .filter((l) => l.end > start && l.start < end)
    .map((l) => ({ ...l, key: keyOf(l.speaker) }))
    .filter((l): l is SpeakerLine & { key: number } => l.key !== null)
    .sort((a, b) => a.start - b.start)
  if (inside.length === 0) return []
  const shots = [{ start, end, key: inside[0].key }]
  for (let i = 0; i < inside.length; i++) {
    const l = inside[i]
    const cur = shots[shots.length - 1]
    if (l.key === cur.key || l.start <= start) continue
    // この人の番: この発話から、同じ人の続きの発話(間が `RUN_JOIN_SEC` まで。間に別の人が話し始めない
    // もの)を1つの番としてまとめ、長さを測る。答える人が短い発話を間を空けて続けても1つの番になる
    // (前は間 1 秒までしかつながず、2 秒未満の発話を 1 秒以上空けて話すと一度も切り替わらなかった)
    let runEnd = l.end
    for (const x of inside.slice(i + 1)) {
      if (x.key === l.key) {
        if (x.start <= runEnd + RUN_JOIN_SEC) runEnd = Math.max(runEnd, x.end)
        else break
      } else if (x.start >= runEnd) break
    }
    runEnd = Math.min(end, runEnd)
    // 相づち: この番の間、今映している人も話している(半分以上重なる)なら切り替えない
    let covered = 0
    for (const x of inside)
      if (x.key === cur.key)
        covered += Math.max(0, Math.min(x.end, runEnd) - Math.max(x.start, l.start))
    if (
      l.start - cur.start < minShot ||
      end - l.start < minShot ||
      runEnd - l.start < minShot ||
      covered >= (runEnd - l.start) * 0.5
    )
      continue
    cur.end = l.start
    shots.push({ start: l.start, end, key: l.key })
  }
  return shots
}

/**
 * 話す人の切り替えで分けたクリップの素材の位置を、書き出しのコマにそろえる(その場で直す)。
 * 書き出しはクリップの頭を `computeMainTrackLayout` でコマに丸めた所から素材を読む。分けた2本目以降の頭の
 * 素材の位置を「1本目の頭のコマ + コマの差」から求めないと、分けた所で音が飛ぶ・途切れる。コマの番号は
 * 書き出しと同じ関数・同じ入力(素材のある本編のクリップ・出力のフレームレート)で求め、整数のコマで差を取る
 * (式を写して丸めると、ちょうど半コマの時刻で小数の誤差により1コマずれた: 25fps・前のクリップ 2.7 秒で
 * 40ms、50fps・2.71 秒で 20ms)。分けた所のタイムラインの時刻は、コマの真ん中の側へごくわずか(1コマの
 * 1万分の1)寄せて、半コマちょうどで丸めが揺れないようにする
 */
function alignSplitPieces(
  clips: Clip[],
  assets: ReadonlyMap<string, MediaAsset>,
  originOf: ReadonlyMap<string, string>
): void {
  if (originOf.size === 0) return
  const fps = projectFrameRate(
    clips,
    clips.map((c) => assets.get(c.assetId)).filter((a): a is MediaAsset => a !== undefined)
  )
  if (!(fps > 0)) return
  for (let round = 0; round < 4; round++) {
    // 素材のあるクリップ(書き出しの本編)の、並びの位置 → 書き出しの番号
    const slot: number[] = []
    const main: Clip[] = []
    for (const c of clips) {
      slot.push(assets.has(c.assetId) ? main.length : -1)
      if (assets.has(c.assetId)) main.push(c)
    }
    const layout = computeMainTrackLayout(main, fps)
    const frameAt = (i: number): number => Math.round(layout.exportStarts[slot[i]] * fps)
    let changed = false
    for (let i = 0; i < clips.length; i++) {
      const origin = originOf.get(clips[i].id)
      if (!origin || slot[i] < 0) continue
      // 同じ元のクリップの1本目(分けたクリップは並んでいる)
      let j = i
      while (j > 0 && originOf.get(clips[j - 1].id) === origin) j--
      j--
      if (j < 0 || clips[j].id !== origin || slot[j] < 0) continue
      const first = clips[j]
      const f0 = frameAt(j)
      const delta = layout.timelineStarts[slot[j]] * fps - f0
      const frames = frameAt(i) - f0
      const speed = first.speed || 1
      // 半コマちょうどで丸めが揺れないよう、コマの真ん中の側へ 1万分の1コマ寄せる(素材の位置で 2µs 未満)
      const want = first.inPoint + ((frames - delta * 1e-4) / fps) * speed
      if (Math.abs(want - clips[i].inPoint) > 1e-12) {
        changed = true
        clips[i] = { ...clips[i], inPoint: want }
        clips[i - 1] = { ...clips[i - 1], outPoint: want }
      }
    }
    if (!changed) return
  }
}

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
  const twoPeople = options.twoPeople !== false
  const canvas = textCanvasSize('9:16')
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  const placedIn = clipsInRange(project.clips, range)
  const inRange = new Set(placedIn.map((x) => x.clip.id))
  const startOf = new Map(clipsInRange(project.clips).map((x) => [x.clip.id, x.start]))
  const fps = projectFrameRate(project.clips, project.assets)
  let filled = 0
  let onFaces = 0
  let stacked = 0
  let switched = 0
  /** 話者の切り替えで分けたクリップの、元のクリップ(顔を探した画は元のクリップの id で覚えている) */
  const originOf = new Map<string, string>()
  const clips = project.clips.flatMap((c): Clip[] => {
    const asset = assets.get(c.assetId)
    if (!inRange.has(c.id) || !fillsVertical(c, asset, ASPECT, options.refineAutoFill)) return [c]
    filled++
    if (c.cropCenter) return [{ ...c, fillCrop: true }]
    const framing = decideFraming(
      (faces.get(c.id) ?? []).map((s) => s.faces),
      asset!,
      ASPECT,
      twoPeople
    )
    if (!framing) return [{ ...c, fillCrop: true, cropCenter: { x: 0.5, y: 0.5 } }]
    onFaces++
    if (framing.kind === 'single') return [{ ...c, fillCrop: true, cropCenter: framing.center }]
    // 2人が収まらない: 話者と顔の対応があれば話している人へ切り替える。無ければ上下に積む
    const byFace = options.speakers?.faces.get(c.assetId)
    // 速さを変えたクリップは分けない(分けると書き出しが速さの掛け直しで音をずらし・途切れさせる。
    // 59.94fps・速さ 0.8 で 14.5ms のずれ、30fps・速さ 0.5 で途切れ)。上下に積む
    if (byFace && options.speakers && (c.speed || 1) === 1) {
      const people = framing.people
      const keyOf = (speaker: string): number | null => {
        const x = byFace.get(speaker)
        if (x === undefined) return null
        // 対応の顔の位置にいちばん近い人(上下に積む2人のどちらか)
        const d = people.map((p) => Math.abs(p.cx - x))
        const k = d[0] <= d[1] ? 0 : 1
        return d[k] <= Math.max(people[k].w, people[k].hi - people[k].lo) * 1.5 ? k : null
      }
      const clipStart = startOf.get(c.id) ?? 0
      const speed = c.speed || 1
      const clipEnd = clipStart + (c.outPoint - c.inPoint) / speed
      const shots = speakerShots(options.speakers.lines, clipStart, clipEnd, keyOf)
      if (shots.length > 0) {
        switched++
        // 切り替えの時刻はコマにそろえ、素材の位置は書き出しが丸めたクリップの頭から数える。書き出しは
        // クリップの頭を(タイムラインの累積で)コマに丸めた所から素材を読む(`computeMainTrackLayout`)ので、
        // 丸める前の頭から数えると、分けた所で素材の位置が最大半コマずれ、音が途切れる・飛ぶ(1本目が
        // 1.01 秒のとき切り替えの直前に約 10ms の無音、1.0167 秒のとき約 16ms の音飛び)。
        // 丸めた頭から数えると、分けた後のクリップの頭のタイムラインの時刻も同じコマに丸まり、素材は続く
        const frameAt = (t: number): number => frameCountForDuration(t, fps) / fps
        const exportStart = frameAt(clipStart)
        const sourceAt = shots.map((s, i) =>
          i === 0 ? c.inPoint : c.inPoint + (frameAt(s.start) - exportStart) * speed
        )
        return shots
          .map((s, i) => {
            const person = people[s.key]
            const id = i === 0 ? c.id : `${c.id}~v${i}`
            if (i > 0) originOf.set(id, c.id)
            const piece: Clip = {
              ...c,
              id,
              inPoint: sourceAt[i],
              outPoint: i + 1 < sourceAt.length ? sourceAt[i + 1] : c.outPoint,
              fillCrop: true,
              cropCenter: { x: person.cx, y: 0.5 }
            }
            if (i > 0) delete piece.transitionIn
            return piece
          })
          .filter((p) => p.outPoint - p.inPoint > 1e-6)
      }
    }
    stacked++
    const top = framing.split.top
    return [
      {
        ...c,
        fillCrop: true,
        // 書き出しは上下に積む。画面のプレビュー(積む形を持たない)は上の人に寄せて見せる
        cropCenter: { x: top.x + top.w / 2, y: 0.5 },
        splitStack: framing.split
      }
    ]
  })
  alignSplitPieces(clips, assets, originOf)
  const result = { filled, onFaces, stacked, switched }
  if (filled === 0 && !options.alwaysLift) return { project, ...result, movedTelops: 0 }

  // 発言テロップ: Shorts の下の帯に隠れない高さへ上げ、切り出した絵の顔に掛かるなら上へ
  const placed = clipsInRange(clips)
  const faceAt = (t: number): { faces: FaceBox[]; stack: boolean } => {
    const p = placed.find((x) => t >= x.start && t < x.end)
    if (!p || !p.clip.fillCrop || !p.clip.cropCenter) return { faces: [], stack: false }
    const asset = assets.get(p.clip.assetId)
    const stack = Boolean(p.clip.splitStack)
    const found = (faces.get(originOf.get(p.clip.id) ?? p.clip.id) ?? []).filter(
      (s) => s.faces !== null
    )
    if (!asset || found.length === 0) return { faces: [], stack }
    // その時刻(素材の秒)にいちばん近い画の顔
    const src = p.clip.inPoint + (t - p.start) * (p.clip.speed || 1)
    const near = found.reduce((a, b) => (Math.abs(b.time - src) < Math.abs(a.time - src) ? b : a))
    if (p.clip.splitStack)
      return { faces: stackFacesOnCanvas(near.faces!, p.clip.splitStack, canvas.h), stack }
    const fit = coverRect(asset, canvas, p.clip.cropCenter)
    return { faces: near.faces!.map((f) => faceToCanvas(f, fit)), stack }
  }
  // 位置を手で決めた枚(自由配置)・下以外の枚は動かさない。文字だけ直した枚は、前後の枚と同じく上げる
  // (直した枚だけが下の帯の高さに残り、前後の枚と高さが跳んでいた)
  const speech = (o: TextOverlay): boolean =>
    Boolean(o.utteranceId) && o.style.position === 'bottom' && !o.style.customPosition
  const lifted = liftAboveShortsUi(project.textOverlays, canvas.h, { canvasW: canvas.w })
  const seamY = stackTopHeight(canvas.h) / canvas.h
  /** 上下に積んだ所の境目に掛かるか */
  const onSeam = (r: Rect): boolean => r.y < seamY + SEAM_MARGIN && r.y + r.h > seamY - SEAM_MARGIN
  let movedTelops = 0
  const textOverlays = project.textOverlays.map((o, i) => {
    // 自動のショートは、組み立てが上げていた枚(下のテロップ全部)を今までどおり上げる
    if (!speech(o)) return options.alwaysLift ? lifted[i] : o
    if (range && (o.endTime <= range.start || o.startTime >= range.end)) return o
    const { faces: faceList, stack } = faceAt((o.startTime + o.endTime) / 2)
    const up = lifted[i]
    const pos = up.style.customPosition
    const bottomRect = telopRect(up, canvas, 'bottom')
    const rect = pos ? { ...bottomRect, y: pos.y - bottomRect.h / 2 } : bottomRect
    if (stack) {
      // 上下に積んだ所: 顔にも境目にも掛からない所へ(上げた位置 → 上 → 下の人の顔のすぐ下 → 上の人の顔の
      // すぐ下の順)。どこも掛かるなら上げた位置のまま
      const clear = (r: Rect): boolean => !onSeam(r) && !coversFace(r, faceList)
      if (clear(rect)) return up
      const topRect = telopRect(o, canvas, 'top')
      if (clear(topRect)) {
        movedTelops++
        return { ...o, style: { ...o.style, position: 'top' as const } }
      }
      const below = (lo: number, hi: number): number | null => {
        const faceBottom = Math.max(
          lo,
          ...faceList
            .filter((f) => f.score >= MIN_SCORE && f.y < hi && f.y + f.h > lo)
            .map((f) => f.y + f.h)
        )
        const y = faceBottom + SEAM_MARGIN
        return y + rect.h <= hi ? y : null
      }
      for (const y of [below(seamY, SHORTS_TELOP_BOTTOM), below(0, seamY - SEAM_MARGIN)]) {
        if (y === null) continue
        const r = { ...rect, y }
        if (!clear(r)) continue
        movedTelops++
        return {
          ...up,
          style: { ...up.style, customPosition: { x: pos?.x ?? 0.5, y: y + rect.h / 2 } }
        }
      }
      return up
    }
    if (faceList.length > 0 && coversFace(rect, faceList)) {
      if (!coversFace(telopRect(o, canvas, 'top'), faceList)) {
        movedTelops++
        return { ...o, style: { ...o.style, position: 'top' as const } }
      }
    }
    return up
  })
  return { project: { ...project, clips, textOverlays }, ...result, movedTelops }
}

/** 口の動きを測る画の大きさ(素材の縦横比は見ない。顔の枠は素材の比なので、そのまま当てられる) */
const MOUTH_FRAME = { w: 320, h: 180 }
/** 話者ごとに口の動きを測る発話の数 */
const MOUTH_SAMPLES_PER_SPEAKER = 3
/** 口の動きを測る発話の長さの下限(秒) */
const MOUTH_MIN_LINE_SEC = 0.8
/** 1つの発話で読む画の時刻(発話の真ん中からの秒)。隣どうしの差を足す */
const MOUTH_OFFSETS = [-0.2, -0.067, 0.067, 0.2]
/**
 * 話者と顔を対応づける確かさ: 話者が話している間の、その顔の口の動きの割合が、ほかの顔より何倍大きければ
 * 対応とみなすか
 */
const MOUTH_MARGIN = 1.3

/** タイムラインの発話のうち、話者のあるもの(範囲の中だけ。時刻順) */
export function speakerLines(
  project: Project,
  range?: { start: number; end: number }
): SpeakerLine[] {
  return placedUtterances(project)
    .filter((p) => p.utterance.speaker?.trim())
    .filter((p) => !range || (p.end > range.start && p.start < range.end))
    .map((p) => ({
      speaker: p.utterance.speaker!.trim(),
      start: p.start,
      end: p.end,
      ...(p.utterance.overlap ? { overlap: true } : {})
    }))
}

/**
 * 口のあたり(顔の枠の下の方)の動き。同じ所を少しずつ違う時刻で読んだ画(rgb24)の、隣どうしの明るさの差の
 * 平均。顔ごとに返す。読めない画があれば null
 */
export function mouthActivity(
  frames: readonly (Uint8Array | null)[],
  size: { w: number; h: number },
  people: readonly Pick<FaceGroup, 'cx' | 'cy' | 'w' | 'h'>[]
): number[] | null {
  if (frames.length < 2 || frames.some((f) => !f || f.length < size.w * size.h * 3)) return null
  const luma = (f: Uint8Array, i: number): number =>
    0.299 * f[i * 3] + 0.587 * f[i * 3 + 1] + 0.114 * f[i * 3 + 2]
  return people.map((p) => {
    // 口: 顔の枠の横の真ん中 7 割、縦は顔の下 4 割〜顎の少し下
    const x0 = Math.max(0, Math.floor((p.cx - p.w * 0.35) * size.w))
    const x1 = Math.min(size.w, Math.ceil((p.cx + p.w * 0.35) * size.w))
    const y0 = Math.max(0, Math.floor((p.cy + p.h * 0.1) * size.h))
    const y1 = Math.min(size.h, Math.ceil((p.cy + p.h * 0.6) * size.h))
    let sum = 0
    let n = 0
    for (let k = 1; k < frames.length; k++) {
      const a = frames[k - 1]!
      const b = frames[k]!
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = y * size.w + x
          sum += Math.abs(luma(a, i) - luma(b, i))
          n++
        }
    }
    return n > 0 ? sum / n : 0
  })
}

/**
 * 話者ごとの口の動きの割合(発話ごとに、顔ごとの動き ÷ 全部の顔の動き の平均)から、話者 → 顔の番号を決める。
 * 一番の顔が次の顔の `MOUTH_MARGIN` 倍以上のときだけ対応とする。2人の話者が同じ顔になったら、割合の大きい
 * 方だけ残す。違う顔に対応した話者が2人に満たなければ null(切り替えられない)
 */
export function assignSpeakers(
  shares: ReadonlyMap<string, readonly number[]>
): Map<string, number> | null {
  const best = new Map<string, { k: number; share: number }>()
  for (const [speaker, s] of shares) {
    if (s.length < 2) continue
    const order = s.map((v, k) => ({ v, k })).sort((a, b) => b.v - a.v)
    if (!(order[0].v > 0) || order[0].v < order[1].v * MOUTH_MARGIN) continue
    best.set(speaker, { k: order[0].k, share: order[0].v })
  }
  const byFace = new Map<number, { speaker: string; share: number }>()
  for (const [speaker, b] of best) {
    const cur = byFace.get(b.k)
    if (!cur || b.share > cur.share) byFace.set(b.k, { speaker, share: b.share })
  }
  if (byFace.size < 2) return null
  return new Map([...byFace].map(([k, v]) => [v.speaker, k]))
}

/**
 * 話者と顔の対応を、話している間の口の動きで決める(話者が2人以上に分かれている回だけ。マイク1本の回は
 * 話者が1人なので null)。2人が縦の枠に収まらないクリップの素材ごとに、話者ごとの長めの発話の真ん中の画を
 * 少しずつずらして読み、どの顔の口が動いているかを見る。読めない・確かめられないときは null
 */
export async function findSpeakerFaces(
  project: Project,
  faces: ReadonlyMap<string, readonly FaceSample[]>,
  options: VerticalFillOptions & { signal?: AbortSignal } = {}
): Promise<SpeakerFaces | null> {
  const lines = speakerLines(project, options.range)
  if (new Set(lines.map((l) => l.speaker)).size < 2) return null
  if (typeof window === 'undefined' || typeof window.api?.framesRgb !== 'function') return null
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  // 2人が収まらないクリップ(素材ごと)
  const byAsset = new Map<
    string,
    { clip: Clip; start: number; end: number; samples: FaceSample[] }[]
  >()
  for (const p of clipsInRange(project.clips, options.range)) {
    const asset = assets.get(p.clip.assetId)
    if (!fillsVertical(p.clip, asset, ASPECT, options.refineAutoFill) || p.clip.cropCenter) continue
    const samples = [...(faces.get(p.clip.id) ?? [])]
    if (
      decideFraming(
        samples.map((s) => s.faces),
        asset!,
        ASPECT,
        true
      )?.kind !== 'stack'
    )
      continue
    const list = byAsset.get(p.clip.assetId) ?? []
    list.push({ ...p, samples })
    byAsset.set(p.clip.assetId, list)
  }
  const out = new Map<string, Map<string, number>>()
  for (const [assetId, list] of byAsset) {
    const asset = assets.get(assetId)!
    const people = faceGroups(list.flatMap((x) => x.samples.map((s) => s.faces)))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4)
    if (people.length < 2) continue
    // 話者ごとに、この素材の2人が収まらないクリップの中の長めの発話
    const picks: { speaker: string; time: number }[] = []
    for (const speaker of new Set(lines.map((l) => l.speaker))) {
      const mine = lines
        .filter((l) => l.speaker === speaker && l.end - l.start >= MOUTH_MIN_LINE_SEC)
        .map((l) => ({ l, at: list.find((x) => l.start >= x.start && l.end <= x.end) }))
        .filter((x): x is { l: SpeakerLine; at: (typeof list)[number] } => x.at !== undefined)
        .sort(
          (a, b) =>
            Number(Boolean(a.l.overlap)) - Number(Boolean(b.l.overlap)) ||
            b.l.end - b.l.start - (a.l.end - a.l.start)
        )
        .slice(0, MOUTH_SAMPLES_PER_SPEAKER)
      for (const { l, at } of mine)
        picks.push({
          speaker,
          time: at.clip.inPoint + ((l.start + l.end) / 2 - at.start) * (at.clip.speed || 1)
        })
    }
    if (picks.length === 0) continue
    const requests = picks.flatMap((p) =>
      MOUTH_OFFSETS.map((d) => ({ path: asset.filePath, time: Math.max(0, p.time + d) }))
    )
    if (options.signal?.aborted) throw new Error('EXPORT_CANCELED')
    let frames: (Uint8Array | null)[]
    try {
      frames = (await window.api.framesRgb(requests, MOUTH_FRAME)) ?? []
    } catch {
      continue
    }
    if (options.signal?.aborted) throw new Error('EXPORT_CANCELED')
    const sums = new Map<string, { total: number[]; n: number }>()
    picks.forEach((p, i) => {
      const act = mouthActivity(
        frames.slice(i * MOUTH_OFFSETS.length, (i + 1) * MOUTH_OFFSETS.length),
        MOUTH_FRAME,
        people
      )
      const all = act?.reduce((t, v) => t + v, 0) ?? 0
      if (!act || !(all > 0)) return
      const s = sums.get(p.speaker) ?? { total: people.map(() => 0), n: 0 }
      act.forEach((v, k) => (s.total[k] += v / all))
      s.n++
      sums.set(p.speaker, s)
    })
    const shares = new Map([...sums].map(([sp, s]) => [sp, s.total.map((v) => v / s.n)]))
    const assigned = assignSpeakers(shares)
    if (!assigned) continue
    out.set(assetId, new Map([...assigned].map(([sp, k]) => [sp, people[k].cx])))
  }
  return out.size > 0 ? { faces: out, lines } : null
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
  const byAsset = new Map<string, { id: string; mid: number; len: number }[]>()
  for (const { clip } of clipsInRange(project.clips, options.range)) {
    const asset = assets.get(clip.assetId)
    if (!fillsVertical(clip, asset, ASPECT, options.refineAutoFill) || clip.cropCenter) continue
    const list = byAsset.get(clip.assetId) ?? []
    list.push({
      id: clip.id,
      mid: (clip.inPoint + clip.outPoint) / 2,
      len: (clip.outPoint - clip.inPoint) / (clip.speed || 1)
    })
    byAsset.set(clip.assetId, list)
  }
  const requests: FacePlan['requests'] = []
  const perClip = new Map<string, number[]>()
  // 全体の上限を必ず守る。素材が多ければ素材ごとに1枚、それでも上限を超えれば、本編で長く使う素材から
  // (下限を素材ごとに守ると、60 素材で 120 枚になっていた)。探さない素材のクリップは真ん中で埋める
  const usedLength = (list: { len: number }[]): number => list.reduce((t, x) => t + x.len, 0)
  const assetsByUse = [...byAsset.entries()]
    .sort((a, b) => usedLength(b[1]) - usedLength(a[1]))
    .slice(0, MAX_FACE_FRAMES)
  const perAsset = Math.max(
    1,
    Math.min(
      MAX_PER_ASSET,
      Math.floor(MAX_FACE_FRAMES / Math.max(1, assetsByUse.length)),
      assetsByUse.length * MIN_PER_ASSET <= MAX_FACE_FRAMES ? Infinity : 1
    )
  )
  for (const [assetId, list] of assetsByUse) {
    const asset = assets.get(assetId)!
    const mids = list.map((x) => x.mid).sort((a, b) => a - b)
    const span = mids[mids.length - 1] - mids[0]
    const gap = Math.max(MIN_SAMPLE_GAP_SEC, span / Math.max(1, perAsset - 1))
    const times: number[] = []
    if (perAsset === 1) times.push(mids[Math.floor(mids.length / 2)])
    else
      for (const m of mids)
        if (times.length === 0 || m - times[times.length - 1] >= gap) times.push(m)
    // 間隔で選んでも、素材ごとの枚数は超えない
    times.splice(perAsset)
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
 * 真ん中で切り出す。話者が分かれている回は、話者と顔の対応を確かめて、話している人へ切り替える
 */
export async function prepareVerticalFill(
  project: Project,
  options: VerticalFillOptions & {
    signal?: AbortSignal
    onProgress?: (done: number, total: number) => void
    /** 顔を探して寄せる(false はゲーム実況: 顔は探さず真ん中で埋める) */
    findFaces?: boolean
  } = {}
): Promise<VerticalFillResult> {
  if (options.findFaces === false) return applyVerticalFill(project, new Map(), options)
  const plan = planFaceFrames(project, options)
  const found = await detectFaceFrames(plan.requests, options)
  const faces = new Map<string, FaceSample[]>()
  for (const [id, idx] of plan.perClip)
    faces.set(
      id,
      idx.map((i) => ({ time: plan.requests[i].time, faces: found[i] ?? null }))
    )
  const speakers =
    options.speakers !== undefined || options.twoPeople === false
      ? options.speakers
      : await findSpeakerFaces(project, faces, options)
  return applyVerticalFill(project, faces, { ...options, speakers })
}

/**
 * 縦の書き出しで、顔を探して寄せるか。ゲーム実況はゲーム画面なので顔は探さず、真ん中で埋める(今までどおり)。
 * `fallbackKind` は企画に種類が無いとき(古い企画)の種類。自動編集の画面の種類 → 設定の順で渡す
 * (書き出しと自動のショートで同じ決め方)
 */
export function framesOnFaces(project: Project, fallbackKind?: EpisodeKind | null): boolean {
  return (project.autoEdit?.kind ?? fallbackKind) !== 'game'
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
  /** 2人を上下に積む(書き出しと同じ窓) */
  stack?: StackSplit
}

/**
 * 書き出し画面に出す、縦の画の見本(タイムラインの `times` の所)。書き出しと同じ決め方(同じ範囲で顔を探し、
 * 1人に寄せる・上下に積む・話している人へ切り替える)で切り出す
 */
export async function verticalSamples(
  project: Project,
  times: readonly number[],
  /** 枠を埋めて切り出す設定(false は黒帯) */
  fill: boolean,
  /** 顔を探して寄せる(false はゲーム実況: 真ん中) */
  findFaces = true,
  signal?: AbortSignal,
  /** 2人が収まらないとき上下に積む・話している人へ切り替える(false は1人に寄せる) */
  twoPeople = true
): Promise<VerticalSample[]> {
  const assets = new Map(project.assets.map((a) => [a.id, a]))
  // 積む・切り替えは「人物に寄せる(2人は上下・話す人)」の設定のときだけ(保存した企画の分も)
  let framed = fill && twoPeople ? project : withoutVerticalSplits(project)
  if (fill && times.length > 0) {
    const lo = Math.min(...times)
    const hi = Math.max(...times)
    framed = (
      await prepareVerticalFill(framed, {
        range: { start: lo, end: hi + 1e-3 },
        findFaces,
        twoPeople,
        signal
      })
    ).project
  }
  const placed = clipsInRange(framed.clips)
  const out: VerticalSample[] = []
  for (const at of times) {
    const p = placed.find((x) => at >= x.start && at < x.end)
    const asset = p ? assets.get(p.clip.assetId) : undefined
    if (!p || !asset) continue
    const time = asset.still ? 0 : p.clip.inPoint + (at - p.start) * (p.clip.speed || 1)
    out.push({
      at,
      filePath: asset.filePath,
      time,
      still: Boolean(asset.still),
      sourceAspect: asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 16 / 9,
      fill: p.clip.fillCrop === true,
      center: p.clip.cropCenter ?? { x: 0.5, y: 0.5 },
      ...(p.clip.splitStack ? { stack: p.clip.splitStack } : {})
    })
  }
  return out
}

/**
 * 書き出し画面の見本の覚え方の鍵。企画・設定と、見本の時刻に掛かるクリップの中身(素材・区間・速さ・
 * 見え方)と、話者・文字起こしの指紋(企画の中身が変われば別の鍵)
 */
export function verticalSampleKey(
  project: Project,
  times: readonly number[],
  fill: boolean,
  findFaces: boolean,
  twoPeople = true
): string {
  const placed = clipsInRange(project.clips)
  const parts = times.map((t) => {
    const p = placed.find((x) => t >= x.start && t < x.end)
    if (!p) return `${t.toFixed(2)}:-`
    const c = p.clip
    return [
      t.toFixed(2),
      p.start.toFixed(3),
      c.id,
      c.assetId,
      c.inPoint,
      c.outPoint,
      c.speed ?? 1,
      c.fillCrop ?? '',
      c.cropCenter ? `${c.cropCenter.x},${c.cropCenter.y}` : '',
      c.blurBackground ?? ''
    ].join(':')
  })
  // 話者と文字起こし(話す人への切り替えは発話の話者・時刻で決まる。話者を直したら見本も作り直す)
  if (twoPeople)
    for (const u of project.transcript ?? [])
      parts.push(
        `${u.assetId}:${u.speaker ?? ''}:${u.sourceStart}:${u.sourceEnd}:${u.overlap ? 1 : 0}`
      )
  let h = 0x811c9dc5
  const text = parts.join('|')
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${project.id}|${fill}|${findFaces}|${twoPeople}|${h.toString(16)}`
}

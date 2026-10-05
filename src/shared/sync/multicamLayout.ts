import type { SourceKind } from '../ingest/classify'
import { GAP_TOLERANCE } from './multicam'
import type { Placement } from './solve'

/**
 * 同期した素材を、今のタイムライン(本編 V1 + PiP トラック + 音声トラック)に並べる形にする。
 *
 * 本編は隙間なく並ぶ作りなので、**基準カメラ**(同期できた長さが一番長いカメラ)の録画を本編に置き、
 * 基準カメラが録っていない時間(録画を止めていた間)は詰める。ほかのカメラ・マイクは同じ時刻の
 * 位置へ置き、詰めた時間に掛かる部分は切り分ける(その時間の映像・音は使わない)。
 * どのアングルを使うかを決めるのはフェーズ2(アングルの自動切替)。ここは「全部が同じ時刻に揃っている」
 * 状態を作るまで。
 */

export interface LayoutFile {
  id: string
  sourceId: string
  duration: number
}

export interface LayoutSource {
  id: string
  name: string
  kind: SourceKind
}

export interface LayoutPiece {
  fileId: string
  /** タイムライン上の頭(秒) */
  startTime: number
  inPoint: number
  outPoint: number
  /**
   * 再生速度(素材の時計のずれの補正)。素材の (outPoint - inPoint) 秒を、タイムラインの
   * (outPoint - inPoint) / speed 秒に収める。ずれが無ければ 1
   */
  speed: number
}

export interface MulticamLayout {
  /** 基準カメラ(本編に並べたカメラ) */
  anchorSourceId: string
  main: { fileId: string; inPoint: number; outPoint: number; speed: number }[]
  /** ほかのカメラ(PiP トラックに1台ずつ) */
  cameras: { sourceId: string; name: string; pieces: LayoutPiece[] }[]
  /** マイク(音声トラックに1本ずつ) */
  mics: { sourceId: string; name: string; pieces: LayoutPiece[] }[]
  /** 同期できず、並べなかった素材 */
  leftOut: string[]
  /**
   * 同期できた素材の位置(基準カメラの時計の共通の時間軸)。仮編集(構成・カット・アングル)を
   * 後から作り直すために企画に残す
   */
  placed: { fileId: string; sourceId: string; start: number; rate: number; duration: number }[]
  /** タイムラインの長さ(秒) */
  duration: number
}

const EPS = 1e-6

/**
 * 同じトラックの続くファイルが、同期の丸めでわずかに重なることがある。
 * 重なったクリップは置けない(同じ機材の声が二重に鳴る)ので、重なりの大きさによらず、
 * 後ろのクリップの頭を前のクリップの終わりまで削る(残りがごく短ければ捨てる)
 */
function trimOverlaps(pieces: LayoutPiece[]): LayoutPiece[] {
  const out: LayoutPiece[] = []
  for (const p of pieces) {
    const last = out[out.length - 1]
    const lastEnd = last ? last.startTime + (last.outPoint - last.inPoint) / last.speed : -Infinity
    const overlap = lastEnd - p.startTime
    if (overlap > EPS) {
      const trimmed = {
        ...p,
        startTime: lastEnd,
        inPoint: p.inPoint + overlap * p.speed
      }
      if ((trimmed.outPoint - trimmed.inPoint) / trimmed.speed >= GAP_TOLERANCE) out.push(trimmed)
      continue
    }
    out.push(p)
  }
  return out
}

export function buildMulticamLayout(
  sources: readonly LayoutSource[],
  files: readonly LayoutFile[],
  placements: readonly Placement[]
): MulticamLayout | null {
  const raw = new Map(placements.map((p) => [p.id, p]))
  const synced = files.filter((f) => {
    const p = raw.get(f.id)
    return p && p.method !== 'none'
  })
  const leftOut = files.filter((f) => !synced.includes(f)).map((f) => f.id)
  const kindOf = new Map(sources.map((s) => [s.id, s.kind]))

  // 基準カメラ: 同期できた長さの合計が一番長いカメラ
  const coverage = new Map<string, number>()
  for (const f of synced) {
    if (kindOf.get(f.sourceId) !== 'camera') continue
    coverage.set(f.sourceId, (coverage.get(f.sourceId) ?? 0) + f.duration)
  }
  const anchorSourceId = [...coverage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!anchorSourceId) return null

  // 基準カメラの時計を共通の時間軸にする(本編の映像は速度を変えずに済む)。
  // 同期の結果は「最初に並べた素材の時計」の秒なので、基準カメラの時計の秒に直す
  const anchorFile = synced.find((f) => f.sourceId === anchorSourceId)!
  const anchorRate = raw.get(anchorFile.id)!.rate || 1
  const place = new Map(
    [...raw.values()].map((p) => [
      p.id,
      { start: p.start * anchorRate, rate: (p.rate || 1) / anchorRate }
    ])
  )
  /** 共通の時間軸での長さ */
  const spanOf = (f: LayoutFile): number => f.duration / place.get(f.id)!.rate

  // 基準カメラの録画区間を時刻順に並べ、重なっていれば後ろを詰める(1台で同時に2本は録れない)
  const segments: {
    fileId: string
    start: number
    end: number
    inPoint: number
    timeline: number
    rate: number
  }[] = []
  let timeline = 0
  let lastEnd = -Infinity
  for (const f of synced
    .filter((x) => x.sourceId === anchorSourceId)
    .sort((a, b) => place.get(a.id)!.start - place.get(b.id)!.start)) {
    const { start, rate } = place.get(f.id)!
    const begin = Math.max(start, lastEnd)
    const end = start + spanOf(f)
    // 1フレームに満たない断片(前のファイルと重なった残りなど)は本編に置かない
    if (end - begin < GAP_TOLERANCE) {
      lastEnd = Math.max(lastEnd, end)
      continue
    }
    segments.push({
      fileId: f.id,
      start: begin,
      end,
      inPoint: (begin - start) * rate,
      timeline,
      rate
    })
    timeline += end - begin
    lastEnd = end
  }

  /**
   * 素材を、基準カメラの録画区間ごとに切ってタイムラインへ写す。
   * 素材の時計の秒(in/out)と共通の時間軸の秒(タイムライン)は rate で換算する
   */
  const mapFile = (f: LayoutFile): LayoutPiece[] => {
    const { start, rate } = place.get(f.id)!
    const end = start + spanOf(f)
    const pieces: LayoutPiece[] = []
    for (const seg of segments) {
      const a = Math.max(start, seg.start)
      const b = Math.min(end, seg.end)
      // 区間の端に1フレーム未満だけ掛かった断片は置かない
      if (b - a < GAP_TOLERANCE) continue
      pieces.push({
        fileId: f.id,
        startTime: seg.timeline + (a - seg.start),
        inPoint: (a - start) * rate,
        outPoint: (b - start) * rate,
        speed: rate
      })
    }
    return pieces
  }

  const group = (kind: SourceKind): { sourceId: string; name: string; pieces: LayoutPiece[] }[] =>
    sources
      .filter((s) => s.kind === kind && s.id !== anchorSourceId)
      .map((s) => ({
        sourceId: s.id,
        name: s.name,
        pieces: trimOverlaps(
          synced
            .filter((f) => f.sourceId === s.id)
            .flatMap(mapFile)
            .sort((x, y) => x.startTime - y.startTime)
        )
      }))
      .filter((g) => g.pieces.length > 0)

  return {
    anchorSourceId,
    main: segments.map((s) => ({
      fileId: s.fileId,
      inPoint: s.inPoint,
      outPoint: s.inPoint + (s.end - s.start) * s.rate,
      speed: s.rate
    })),
    cameras: group('camera'),
    mics: group('mic'),
    leftOut,
    placed: synced.map((f) => ({
      fileId: f.id,
      sourceId: f.sourceId,
      start: place.get(f.id)!.start,
      rate: place.get(f.id)!.rate,
      duration: f.duration
    })),
    duration: timeline
  }
}

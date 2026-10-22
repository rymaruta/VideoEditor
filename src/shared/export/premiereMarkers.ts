import type { Project } from '../types'
import type { ProjectV2, TelopItem } from '../sequence/types'
import { createExportTimeMap } from '../exportTimeline'
import { projectRate, rateValue } from '../frameRate'
import { computeMainTrackLayout } from '../mainTrackLayout'
import { buildSrt } from '../telop/srt'
import { stripTelopMarkup } from '../telop/render'
import type { PremiereMarker } from './premiereXml'

/**
 * Premiere 用 XML に付けるマーカーと、並べて書く SRT。
 *
 * - テロップ: 1 枚ごとに、出ている区間のマーカー(コメントに文字)。FCP7 XML の文字の
 *   ジェネレーターは Premiere で編集できる形にならないので、文字はマーカーと SRT で渡す
 * - 章: 章の見出し・コーナー名の演出テロップ
 * - 要確認: 自動編集の要確認の一覧(画面のプロセスが組んで渡す。時刻はタイムラインの秒)
 *
 * 時刻はすべて v2 のシーケンスのフレーム(書き出しの時刻)。タイムラインの秒は、
 * v2 を作るのと同じ換算(`projectV1ToV2`)でフレームに直す。
 */

/** 要確認の項目(画面の `ReviewItem` のうち、マーカーに要るものだけ) */
export interface ReviewMarkerSource {
  key: string
  kind: string
  text: string
  /** タイムラインの秒 */
  at?: number
  /** そのテロップの所 */
  overlayId?: string
}

export interface PremiereMarkerOptions {
  telops?: boolean
  chapters?: boolean
  reviews?: readonly ReviewMarkerSource[]
}

/** タイムラインの秒 → シーケンスのフレーム(`projectV1ToV2` と同じ換算) */
export function timelineToSequenceFrame(project: Project): (sec: number) => number {
  const assetIds = new Set(project.assets.map((a) => a.id))
  const fps = rateValue(projectRate(project.clips, project.assets))
  const mainClips = project.clips.filter((c) => assetIds.has(c.assetId))
  const layout = computeMainTrackLayout(mainClips, fps)
  const { toExportTime } = createExportTimeMap(
    layout.timelineStarts,
    layout.timelineDurations,
    layout.exportStarts
  )
  return (sec) => Math.round(toExportTime(sec) * fps)
}

function telops(v2: ProjectV2): TelopItem[] {
  return v2.sequence.videoTracks
    .flatMap((t) => t.items.filter((i): i is TelopItem => i.kind === 'telop'))
    .sort((a, b) => a.startFrame - b.startFrame)
}

/** マーカーのコメントに書く1行(飾りの印を外し、改行は空白に) */
function oneLine(text: string): string {
  return stripTelopMarkup(text)
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim()
}

const CHAPTER = /^chapter-/
const CORNER = /^fx-.*-corner-/

export function premiereMarkers(
  project: Project,
  v2: ProjectV2,
  options: PremiereMarkerOptions = {}
): PremiereMarker[] {
  const out: PremiereMarker[] = []
  const items = telops(v2)
  const byId = new Map(items.map((t) => [t.id, t]))
  if (options.chapters !== false) {
    for (const o of project.textOverlays) {
      if (!o.effectId) continue
      const chapter = CHAPTER.test(o.effectId)
      if (!chapter && !CORNER.test(o.effectId)) continue
      const t = byId.get(o.id)
      if (!t) continue
      out.push({
        frame: t.startFrame,
        name: chapter ? `章: ${oneLine(o.text)}` : `コーナー: ${oneLine(o.text)}`,
        comment: oneLine(o.text)
      })
    }
  }
  if (options.reviews && options.reviews.length > 0) {
    const toFrame = timelineToSequenceFrame(project)
    for (const r of options.reviews) {
      const t = r.overlayId ? byId.get(r.overlayId) : undefined
      const frame = t ? t.startFrame : r.at !== undefined ? toFrame(r.at) : undefined
      if (frame === undefined || !Number.isFinite(frame)) continue
      out.push({ frame: Math.max(0, frame), name: `要確認: ${r.kind}`, comment: r.text })
    }
  }
  if (options.telops !== false) {
    for (const t of items) {
      const text = oneLine(t.text)
      if (!text) continue
      out.push({
        frame: t.startFrame,
        durationFrames: t.durationFrames,
        name: 'テロップ',
        comment: text
      })
    }
  }
  return out.sort((a, b) => a.frame - b.frame)
}

/** v2 のテロップを、シーケンスの時刻の SRT にする(Premiere の「キャプション」に読み込める) */
export function premiereSrt(v2: ProjectV2): string {
  const fps = v2.sequence.fps.num / v2.sequence.fps.den
  return buildSrt(
    telops(v2).map((t) => ({
      text: t.text,
      startTime: t.startFrame / fps,
      endTime: (t.startFrame + t.durationFrames) / fps
    }))
  )
}

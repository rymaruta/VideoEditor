import type { Project, TextOverlay } from '@shared/types'
import {
  utteranceTimelineRange,
  type PlacedClipRef,
  type TranscriptUtterance
} from '@shared/transcript'
import { utteranceToTelopChunks } from '@shared/telop/fromTranscript'
import { applyLook, styleForSpeaker, type TelopStyleDef } from '@shared/telop/styles'
import { defaultTextStyle } from '@shared/textStyle'
import { buildTimedClips } from './timelineMath'

/** 企画の全クリップ(本編・PiP・音声)を、タイムラインでの位置つきで並べる */
export function placedClips(project: Project): PlacedClipRef[] {
  const main = buildTimedClips(project).map((tc) => ({
    assetId: tc.clip.assetId,
    startTime: tc.start,
    inPoint: tc.clip.inPoint,
    outPoint: tc.clip.outPoint,
    speed: tc.clip.speed
  }))
  const audio = project.audioTracks.flatMap((t) =>
    t.clips.map((c) => ({
      assetId: c.assetId,
      startTime: c.startTime,
      inPoint: c.inPoint,
      outPoint: c.outPoint,
      speed: c.speed
    }))
  )
  const pip = project.videoOverlayTracks.flatMap((t) =>
    t.clips.map((c) => ({
      assetId: c.assetId,
      startTime: c.startTime,
      inPoint: c.inPoint,
      outPoint: c.outPoint
    }))
  )
  // 声を拾った素材(マイク)のクリップを先に見る
  return [...audio, ...main, ...pip]
}

export interface PlacedUtterance {
  utterance: TranscriptUtterance
  start: number
  end: number
}

/** タイムラインに出ている発話を、時刻順に */
export function placedUtterances(project: Project): PlacedUtterance[] {
  const clips = placedClips(project)
  const out: PlacedUtterance[] = []
  for (const u of project.transcript ?? []) {
    const r = utteranceTimelineRange(u, clips)
    if (r) out.push({ utterance: u, start: r.start, end: r.end })
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * 発話から発言テロップを作る。話者に割り当てたテロップスタイルがあれば、それを使う
 * (テロップ > テロップスタイルの管理 の「自動で使う場面」)。
 */
export function telopsFromTranscript(
  project: Project,
  styles: readonly TelopStyleDef[]
): Omit<TextOverlay, 'id'>[] {
  const clips = placedClips(project)
  const base = defaultTextStyle()
  const out: Omit<TextOverlay, 'id'>[] = []
  for (const u of project.transcript ?? []) {
    const def = styleForSpeaker(styles, u.speaker)
    for (const chunk of utteranceToTelopChunks(u)) {
      const r = utteranceTimelineRange(
        { assetId: u.assetId, sourceStart: chunk.sourceStart, sourceEnd: chunk.sourceEnd },
        clips
      )
      if (!r || r.end - r.start < 0.2) continue
      out.push({
        text: chunk.text,
        startTime: r.start,
        endTime: r.end,
        style: def ? applyLook(base, def.style) : { ...base },
        styleId: def?.id,
        speaker: u.speaker,
        source: 'auto'
      })
    }
  }
  return out.sort((a, b) => a.startTime - b.startTime)
}

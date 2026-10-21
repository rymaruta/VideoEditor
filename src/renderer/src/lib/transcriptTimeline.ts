import type { Project, TextOverlay, TextStyle } from '@shared/types'
import {
  utteranceTimelineRange,
  type PlacedClipRef,
  type TranscriptUtterance
} from '@shared/transcript'
import {
  joinShortTelops,
  joinTelopText,
  settleTelopTimes,
  utteranceToTelopChunks
} from '@shared/telop/fromTranscript'
import { toCommon } from '@shared/sync/multicam'
import {
  speechLook,
  speechTelopStyle,
  styleForSpeaker,
  type TelopStyleDef
} from '@shared/telop/styles'
import { stackSimultaneousTelops } from '@shared/telop/stack'
import { textCanvasSize } from '@shared/resolution'
import type { DictionaryEntry } from '@shared/telop/polish'
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
      outPoint: c.outPoint,
      speed: c.speed
    }))
  )
  // 声を拾った素材(マイク)のクリップを先に見る
  return [...audio, ...main, ...pip]
}

/**
 * 本編で時間が飛ぶ所(タイムラインの秒)。同じ素材の続き・マルチカムで共通の時刻が続く
 * カメラの切り替えは、声も続いているので切れ目にしない
 */
export function mainHardCuts(project: Project): number[] {
  const timed = buildTimedClips(project)
  const fileOf = new Map((project.multicam?.files ?? []).map((f) => [f.assetId, f]))
  const out: number[] = []
  for (let i = 1; i < timed.length; i++) {
    const a = timed[i - 1].clip
    const b = timed[i].clip
    const fa = fileOf.get(a.assetId)
    const fb = fileOf.get(b.assetId)
    const continuous =
      fa && fb
        ? Math.abs(toCommon(fa, a.outPoint) - toCommon(fb, b.inPoint)) < 0.02
        : a.assetId === b.assetId && Math.abs(a.outPoint - b.inPoint) < 0.02
    if (!continuous) out.push(timed[i].start)
  }
  return out
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
  styles: readonly TelopStyleDef[],
  dictionary: readonly DictionaryEntry[] = [],
  /** 番組スタイルで学んだ、1行の文字数・最短の表示時間 */
  telop?: { lineChars: number; minSec: number },
  /** 話者にスタイルを割り当てていない発言の見た目(`speechLook`)。無ければ既定の型 */
  look: { style: TextStyle; styleId?: string } = speechLook(undefined, styles)
): Omit<TextOverlay, 'id'>[] {
  const clips = placedClips(project)
  const out: Omit<TextOverlay, 'id'>[] = []
  for (const u of project.transcript ?? []) {
    const def = styleForSpeaker(styles, u.speaker)
    const chunks = utteranceToTelopChunks(u, {
      dictionary,
      maxLineChars: telop?.lineChars,
      minDurationSec: telop?.minSec
    })
    const placed = chunks.flatMap((chunk, ci) => {
      const r = utteranceTimelineRange(
        { assetId: u.assetId, sourceStart: chunk.sourceStart, sourceEnd: chunk.sourceEnd },
        clips
      )
      // どのクリップに置いたか(違うクリップの枚どうしはまとめない。間にカットがありうる)
      const clip = clips.findIndex(
        (c) =>
          c.assetId === u.assetId &&
          chunk.sourceStart >= c.inPoint - 1e-6 &&
          chunk.sourceStart < c.outPoint
      )
      return r ? [{ ci, clip, text: chunk.text, ...r }] : []
    })
    // 短すぎる枚(辞書で長くして分けた枚・長さ 0 の言葉の枚)は、捨てずに隣の枚にまとめる(仮編集と同じ)
    const short = (x: (typeof placed)[number]): boolean => x.end - x.start < 0.2
    const joined = joinShortTelops(
      placed,
      short,
      (a, b) => a.clip === b.clip,
      (a, b) => ({
        ci: short(a) ? b.ci : a.ci,
        clip: a.clip,
        text: joinTelopText(a.text, b.text),
        start: Math.min(a.start, b.start),
        end: Math.max(a.end, b.end)
      })
    )
    for (const { ci, text, start, end } of joined) {
      out.push({
        text,
        startTime: start,
        endTime: end,
        style: speechTelopStyle(def ? def.style : look.style),
        styleId: def ? def.id : look.styleId,
        speaker: u.speaker,
        source: 'auto',
        utteranceId: u.id,
        // 枚ごとの番号(仮編集と同じ)。無いと1つの発言の枚がみな同じ印になり、直した文字・消した枚が
        // 作り直しで別の枚に付いていた
        utteranceChunk: ci
      })
    }
  }
  // 短い切れ目をつなぎ、読み切れない枚を延ばす(仮編集と同じ規則。時間の飛ぶ切れ目は越えない)
  const settled = settleTelopTimes(out, mainHardCuts(project))
  // 声が重なった所は、後から出たテロップを1段上へ
  return stackSimultaneousTelops(settled, textCanvasSize(project.aspectRatio).h)
}

import { v4 as uuid } from 'uuid'
import type { Project, TextStyle } from '@shared/types'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { HypeMoment } from '@shared/structure/hype'
import { pickShortWindows, type ShortCandidate, type ShortOptions } from '@shared/structure/shorts'
import { CHEER_THRESHOLD, LAUGH_THRESHOLD } from '@shared/events/audioEvents'
import type { TelopStyleDef } from '@shared/telop/styles'
import type { DictionaryEntry } from '@shared/telop/polish'
import { cameraRange, planRoughCut, timedLines } from './roughCutPlan'

/**
 * ゲーム実況のショート(縦型)を作る(`docs/GAME_AUTO_EDIT_PLAN.md` G4)。
 *
 * 区間の選び方は `@shared/structure/shorts`。1本ごとに、本編の仮編集と同じ仕組み(`planRoughCut`)で
 * その区間だけの「声・ゲーム音・顔カメラ・発言テロップ」を組み、9:16 の企画にする。
 * - ゲーム画面: 縦の画面いっぱいに、真ん中を切り出す(多くのゲームは操作しているものが真ん中)
 * - 顔カメラ: 上に横幅いっぱいで出す
 * - 区間の中の長い無言(3 秒を超える)だけを詰める(山の前後の流れは切らない)
 */

/** 顔カメラのワイプ(上・横幅いっぱい) */
export const SHORT_FACE_POSITION = 'top-left' as const
export const SHORT_FACE_SCALE = 1

export interface ShortPlanInput {
  project: Project
  info: MulticamInfo
  hype: readonly HypeMoment[]
  activity: Uint8Array
  styles: readonly TelopStyleDef[]
  speechLook: { style: TextStyle; styleId?: string }
  dictionary?: readonly DictionaryEntry[]
}

/** ショートにする区間(強い順) */
export function shortWindowsFor(
  input: Pick<ShortPlanInput, 'project' | 'info' | 'hype'>,
  options: ShortOptions = {}
): ShortCandidate[] {
  const laughs = (input.project.audioEvents ?? []).filter(
    (e) => e.laugh >= LAUGH_THRESHOLD || e.cheer >= CHEER_THRESHOLD
  )
  return pickShortWindows(
    input.hype,
    laughs,
    timedLines(input.project, input.info),
    cameraRange(input.info),
    options
  )
}

/** 区間1つを、縦型の企画にする */
export function buildShortProject(
  input: ShortPlanInput,
  window: ShortCandidate,
  index: number
): Project {
  const { project, info } = input
  const lines = timedLines(project, info).filter(
    (l) => l.start < window.end && l.end > window.start
  )
  const scene = {
    id: 'short',
    start: window.start,
    end: window.end,
    lines,
    speech: lines.reduce((t, l) => t + (l.end - l.start), 0)
  }
  const plan = planRoughCut(
    project,
    info,
    [scene],
    [{ sceneId: 'short', score: 100, kind: 'highlight', reason: 'ショート' }],
    input.activity,
    {
      targetSec: 0,
      keep: { short: true },
      styles: input.styles,
      speechLook: input.speechLook,
      dictionary: input.dictionary,
      kind: 'game',
      policy: 'light'
    }
  )
  const cut = plan.cut
  const used = new Set([
    ...cut.main.map((m) => m.assetId),
    ...cut.audio.flatMap((a) => a.clips.map((c) => c.assetId)),
    ...(cut.overlays ?? []).flatMap((o) => o.clips.map((c) => c.assetId))
  ])
  const voice = new Set(info.sources.filter((s) => s.kind === 'mic').map((s) => s.id))
  return {
    id: uuid(),
    name: `${project.name} ショート${index + 1}`,
    aspectRatio: '9:16',
    assets: project.assets.filter((a) => used.has(a.id)),
    clips: cut.main.map((m) => ({
      id: uuid(),
      assetId: m.assetId,
      inPoint: m.inPoint,
      outPoint: m.outPoint,
      speed: m.speed,
      audioDetached: true,
      // 縦の画面いっぱいに、ゲーム画面の真ん中を切り出す
      fillCrop: true
    })),
    audioTracks: cut.audio.map((a) => ({
      id: uuid(),
      name: a.name,
      multicamSourceId: a.sourceId,
      muted: a.muted ?? false,
      volume: a.volume,
      autoVolume: a.volume,
      duckingEnabled: false,
      voice: voice.has(a.sourceId),
      clips: a.clips.map((c) => ({
        id: uuid(),
        assetId: c.assetId,
        startTime: c.startTime,
        inPoint: c.inPoint,
        outPoint: c.outPoint,
        ...(Math.abs(c.speed - 1) > 1e-9 ? { speed: c.speed } : {}),
        ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}),
        ...(c.fadeOut ? { fadeOut: c.fadeOut } : {})
      }))
    })),
    videoOverlayTracks: (cut.overlays ?? []).map((o) => ({
      id: uuid(),
      name: o.name,
      multicamSourceId: o.sourceId,
      hidden: false,
      position: SHORT_FACE_POSITION,
      scale: SHORT_FACE_SCALE,
      clips: o.clips.map((c) => ({ id: uuid(), ...c }))
    })),
    textOverlays: plan.telops.map((t) => ({ ...t, id: uuid() })),
    transcript: project.transcript,
    multicam: info,
    audioEvents: project.audioEvents
  }
}

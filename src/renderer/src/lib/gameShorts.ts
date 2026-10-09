import { liftAboveShortsUi } from '@shared/telop/stack'
import { textCanvasSize } from '@shared/resolution'
import { v4 as uuid } from 'uuid'
import type { Project, TextStyle } from '@shared/types'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { HypeMoment } from '@shared/structure/hype'
import {
  pickShortWindows,
  SHORT_MIN_SEC,
  type ShortCandidate,
  type ShortOptions
} from '@shared/structure/shorts'
import { CHEER_THRESHOLD, LAUGH_THRESHOLD } from '@shared/events/audioEvents'
import type { TelopStyleDef } from '@shared/telop/styles'
import { carriesVoice } from '@shared/roughCut/build'
import { PIP_MARGIN_RATIO } from '@shared/pipLayout'
import type { CutOverrides } from '@shared/roughCut/overrides'
import { mergeManualTelops } from '@shared/telop/manual'
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

/**
 * 顔カメラのワイプ(上・横幅いっぱい)。ワイプは隅から余白(`PIP_MARGIN_RATIO`)を空けて置くので、
 * 幅は左右の余白を引いた分にする(幅 1 だと右へ余白ぶんはみ出して切れる)。左右の余白が揃い、真ん中に来る
 */
export const SHORT_FACE_POSITION = 'top-left' as const
export const SHORT_FACE_SCALE = 1 - 2 * PIP_MARGIN_RATIO

export interface ShortPlanInput {
  project: Project
  info: MulticamInfo
  hype: readonly HypeMoment[]
  activity: Uint8Array
  styles: readonly TelopStyleDef[]
  speechLook: { style: TextStyle; styleId?: string }
  dictionary?: readonly DictionaryEntry[]
  /**
   * 本編の人の修正(削った・足した区間、替えたカメラ)。ショートにも当てる
   * (本編で削った所 — 個人の情報・関係の無い話 — をショートに戻さない)
   */
  overrides?: CutOverrides
}

/** ショート1本の長さの上限(秒) */
const SHORT_MAX_SEC = 60
/** 長さが足りないとき、1回に広げる長さ(秒) */
const SHORT_WIDEN_STEP_SEC = 12

/** 組んだショートに、選んだ区間(山)が入っているか */
function coversChosen(plan: ReturnType<typeof planRoughCut>, chosen: ShortCandidate): boolean {
  return plan.pieces.some((p) => p.start < chosen.end && p.end > chosen.start)
}

/** 長さが足りないときに広げる区間の長さの上限(秒) */
const SHORT_MAX_WINDOW_SEC = 120

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
  const { info } = input
  // 間を詰めると、選んだ区間より短くなる(黙っている所を落とすので)。下限に届かなければ、
  // 足りない分だけ区間を前後に広げて組み直す(数回まで。素材の端より先へは広げない)
  const range = cameraRange(info)
  let win = window
  let plan = planShort(input, win, window)
  const hadChosen = coversChosen(plan, window)
  for (let i = 0; i < 8 && plan.cut.duration < SHORT_MIN_SEC; i++) {
    // 詰めた後に残る割合から、下限に届く区間の長さを見込む。一度に広げるのは少しずつ
    // (残りがほぼ無いと一度に 120 秒まで広げ、選んだ所の無い 100 秒のショートになっていた)
    const len = win.end - win.start
    const want = (len * SHORT_MIN_SEC) / Math.max(1, plan.cut.duration) + 2
    const extra = Math.min(SHORT_WIDEN_STEP_SEC, Math.max(2, want - len)) / 2
    const next = {
      ...win,
      start: Math.max(range.start, win.start - extra),
      end: Math.min(range.end, win.end + extra)
    }
    if (next.start === win.start && next.end === win.end) break
    if (next.end - next.start > SHORT_MAX_WINDOW_SEC) break
    const nextPlan = planShort(input, next, window)
    // 上限を超える・選んだ所が入らない組み直しは使わない(前の組み方のまま)
    if (nextPlan.cut.duration > SHORT_MAX_SEC || (hadChosen && !coversChosen(nextPlan, window)))
      break
    win = next
    plan = nextPlan
  }
  return shortProjectFromPlan(input, plan, index)
}

/** 区間1つの仮編集(縦型・軽く詰める) */
function planShort(
  input: ShortPlanInput,
  window: ShortCandidate,
  chosen: ShortCandidate
): ReturnType<typeof planRoughCut> {
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
  return planRoughCut(
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
      policy: 'light',
      aspectRatio: '9:16',
      overrides: input.overrides && {
        ...input.overrides,
        // 足した区間は、選んだショートの区間の中だけ(長さが足りずに広げた分には入れない)
        added: input.overrides.added
          .map((r) => ({
            start: Math.max(r.start, chosen.start),
            end: Math.min(r.end, chosen.end)
          }))
          .filter((r) => r.end > r.start)
      }
    }
  )
}

/** 仮編集から縦型の企画を作る */
function shortProjectFromPlan(
  input: ShortPlanInput,
  plan: ReturnType<typeof planRoughCut>,
  index: number
): Project {
  const { project, info } = input
  const cut = plan.cut
  const used = new Set([
    ...cut.main.map((m) => m.assetId),
    ...cut.audio.flatMap((a) => a.clips.map((c) => c.assetId)),
    ...(cut.overlays ?? []).flatMap((o) => o.clips.map((c) => c.assetId))
  ])
  const voice = new Set(info.sources.filter((s) => carriesVoice(s)).map((s) => s.id))
  return {
    id: uuid(),
    name: `${project.name} ショート${index + 1}`,
    aspectRatio: '9:16',
    // 同期の記録が指す素材は全部残す(使う区間の素材だけにすると、ショートを開いてクリップを伸ばしたとき、
    // 外した素材(分かれたマイクの続きのファイルなど)を指す声・ワイプが入り、黙って鳴らなかった)
    assets: project.assets.filter(
      (a) => used.has(a.id) || info.files.some((f) => f.assetId === a.id)
    ),
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
    audioTracks: cut.audio.map((a) => {
      // 本編で人が決めた消音・音量(仮編集が決めた値から変えたもの)は、ショートでも同じに
      const prev = project.audioTracks.find((t) => t.multicamSourceId === a.sourceId)
      const volumeChanged =
        prev !== undefined && prev.autoVolume !== undefined && prev.volume !== prev.autoVolume
      return {
        id: uuid(),
        name: a.name,
        multicamSourceId: a.sourceId,
        muted: prev?.muted ?? a.muted ?? false,
        volume: volumeChanged ? prev!.volume : a.volume,
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
      }
    }),
    videoOverlayTracks: (cut.overlays ?? []).map((o) => {
      // 本編で人が決めたワイプの表示・音は、ショートでも同じに(置き場所と大きさは縦型の決まり)
      const prev = project.videoOverlayTracks.find((t) => t.multicamSourceId === o.sourceId)
      return {
        id: uuid(),
        name: o.name,
        multicamSourceId: o.sourceId,
        hidden: prev?.hidden ?? false,
        // 声はマイクの音源で鳴らす(カメラの音を足すと二重に聞こえる)
        audioMuted: prev ? prev.audioMuted === true : true,
        position: SHORT_FACE_POSITION,
        scale: SHORT_FACE_SCALE,
        clips: o.clips.map((c) => ({ id: uuid(), ...c }))
      }
    }),
    // 本編で人が直した文字・消したテロップは、ショートでも同じに
    // 下の発言テロップは、Shorts の下部の帯(チャンネル名・説明文)に隠れない高さへ上げる
    textOverlays: liftAboveShortsUi(
      mergeManualTelops(
        project.textOverlays,
        plan.telops,
        new Set(project.dismissedTelops ?? []),
        project.editedTelops
      ),
      textCanvasSize('9:16').h
    ).map((t) => ({ ...t, id: uuid() })),
    transcript: project.transcript,
    multicam: info,
    audioEvents: project.audioEvents
  }
}

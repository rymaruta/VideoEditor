import type { Project } from '@shared/types'
import type { EpisodeKind } from '@shared/structure/kind'
import { heuristicJudgements, type Scene, type SceneJudgement } from '@shared/structure/scenes'
import { spansOfClips } from '@shared/roughCut/overrides'
import { scenesFor } from './roughCutPlan'

type StepState = 'wait' | 'run' | 'done' | 'error' | 'skipped'

/** 開き直した企画から、自動編集の画面の状態を作り直した結果 */
export interface RestoredPipeline<Id extends string = string> {
  steps: Partial<Record<Id, { state: StepState; percent: number; note?: string }>>
  scenes: Scene[]
  judgements: SceneJudgement[]
  roughCut: {
    keptIds: string[]
    kept: number
    dropped: number
    duration: number
    shots: number
    telops: number
  } | null
  /** 企画に残らないため作り直せなかったもの(画面に、何をやり直せばよいかと一緒に出す) */
  missing: string[]
}

const UNKNOWN = '開き直した企画のため分かりません'

/** 場面が今の本編にどれだけ残っているか(共通の時刻で重なる秒数) */
function keptSeconds(scene: Scene, spans: readonly { start: number; end: number }[]): number {
  let t = 0
  for (const s of spans)
    t += Math.max(0, Math.min(scene.end, s.end) - Math.max(scene.start, s.start))
  return t
}

/**
 * 保存した企画(同期の情報・文字起こし・仮編集・テロップ)から、自動編集の画面の状態
 * (工程の済み・構成の場面・残した場面・仮編集の要約)を作り直す。
 * 自動編集の結果は企画にしか残らないので、開き直すと工程が全部「待機」・構成が空になり、
 * 「ショートを作る」「仮編集を作り直す」も押せなかった。
 * 同期と文字起こしが無い企画(手で作った企画)なら null
 */
export function restorePipelineFromProject(
  project: Project,
  kind: EpisodeKind
): RestoredPipeline | null {
  const info = project.multicam
  const transcript = project.transcript ?? []
  if (!info || transcript.length === 0) return null
  const done = (note?: string): { state: StepState; percent: number; note?: string } => ({
    state: 'done',
    percent: 100,
    ...(note ? { note } : {})
  })
  const unknown = { state: 'wait' as StepState, percent: 0, note: UNKNOWN }
  const cameras = info.sources.filter((s) => s.kind === 'camera')
  const mics = info.sources.filter((s) => s.kind === 'mic')
  const assets = project.assets
  const missing: string[] = []

  // 構成の場面は、文字起こしと同期の情報から同じように切り直せる。判定は AI の答えが企画に
  // 残らないので、簡易の点数にする
  const scenes = scenesFor(project, info, { kind })
  const judgements = heuristicJudgements(scenes, kind)
  missing.push(
    '構成の判定(AI の判定・手で決めた残す/落とす)は企画に残らないため、簡易の点数で表示しています'
  )

  // 残した場面は、今の本編に残っている所から読み取る(間を詰めた分があるので、3割以上残っていれば残した)
  const spans = project.clips.length > 0 ? spansOfClips(project.clips, info) : []
  const keptIds = scenes
    .filter((sc) => keptSeconds(sc, spans) >= Math.max(0.5, (sc.end - sc.start) * 0.3))
    .map((sc) => sc.id)
  const speechTelops = project.textOverlays.filter((o) => o.utteranceId).length
  const roughCut =
    project.clips.length > 0 && project.roughCutAuto
      ? {
          keptIds,
          kept: keptIds.length,
          dropped: scenes.length - keptIds.length,
          duration: project.clips.reduce(
            (t, c) => t + Math.max(0, c.outPoint - c.inPoint) / (c.speed || 1),
            0
          ),
          shots: project.clips.length,
          telops: speechTelops
        }
      : null

  const effectTelops = project.textOverlays.filter((o) => o.effectId)
  const autoSound =
    project.audioTracks.some((t) => t.autoRole) ||
    project.videoOverlayTracks.some((t) => t.autoRole)

  const steps: RestoredPipeline['steps'] = {
    ingest: done(`カメラ ${cameras.length} 台 · マイク ${mics.length} 本`),
    sync: done(`${info.files.length} 本を同期`),
    timeline: project.clips.length > 0 ? done() : unknown,
    color:
      cameras.length <= 1
        ? { state: 'skipped', percent: 0, note: 'カメラが1台です' }
        : assets.some((a) => a.colorMatch)
          ? done()
          : unknown,
    denoise:
      mics.length === 0
        ? { state: 'skipped', percent: 0, note: 'ピンマイクがありません' }
        : assets.some((a) => a.denoisedFrom)
          ? done()
          : unknown,
    speakers: done(
      transcript.some((u) => u.speaker) ? undefined : 'ピンマイクが無いため話者は未判定'
    ),
    transcribe: done(`${transcript.length} 件`),
    events: project.audioEvents ? done() : unknown,
    structure: done(
      `場面 ${scenes.length} · 見どころ ${judgements.filter((j) => j.kind === 'highlight').length} · 不要 ${judgements.filter((j) => j.kind === 'unneeded').length} · 簡易(開き直した企画から)`
    ),
    cut: roughCut ? done(`${spans.length} 区間`) : unknown,
    angles: roughCut ? done(`ショット ${project.clips.length}`) : unknown,
    placement: speechTelops > 0 ? done(`発言テロップ ${speechTelops}`) : unknown,
    // 提案の一覧は企画に残らない。「済み」にすると、作り直しで提案を頼まずに空の一覧で置き直し、
    // AI の提案で置いた演出テロップが消える
    effects:
      effectTelops.length > 0
        ? {
            state: 'wait',
            percent: 0,
            note: `置いた演出テロップ ${effectTelops.length}(提案の一覧は企画に残りません)`
          }
        : unknown,
    sound: autoSound ? done() : unknown
  }
  if (effectTelops.length > 0 || roughCut)
    missing.push(
      '演出テロップの提案の一覧は企画に残らないため、選び直すには「仮編集を作り直す」で提案し直してください(AI の提案で置いた演出テロップは、新しい提案に入れ替わります)'
    )
  return { steps, scenes, judgements, roughCut, missing }
}

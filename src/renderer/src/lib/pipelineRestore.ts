import type { Project } from '@shared/types'
import type { EpisodeKind } from '@shared/structure/kind'
import { heuristicJudgements, type Scene, type SceneJudgement } from '@shared/structure/scenes'
import type { HypeMoment } from '@shared/structure/hype'
import type { EffectProposal } from '@shared/telop/effects'
import { spansOfClips } from '@shared/roughCut/overrides'
import { scenesFor } from './roughCutPlan'

type StepState = 'wait' | 'run' | 'done' | 'error' | 'skipped'

/** 開き直した企画から、自動編集の画面の状態を作り直した結果 */
export interface RestoredPipeline<Id extends string = string> {
  steps: Partial<Record<Id, { state: StepState; percent: number; note?: string }>>
  scenes: Scene[]
  judgements: SceneJudgement[]
  planJudgements: SceneJudgement[] | null
  judgeSource: 'ai' | 'heuristic'
  hype: HypeMoment[]
  /** 残す / 落とすの判断(保存した判断。古い企画では今の本編から読み取ったもの) */
  keep: Record<string, boolean>
  targetMinutes: number
  editNote: string
  effects: EffectProposal[]
  effectChosen: string[]
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
  /** 自動編集の判断が残っていない古い企画から読み取ったか */
  legacy: boolean
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
 * 保存した企画(同期の情報・文字起こし・仮編集・テロップ・自動編集の判断)から、自動編集の画面の状態
 * (工程の済み・構成の場面・判定・残す/落とす・仕上がりの長さ・演出テロップの提案・仮編集の要約)を作り直す。
 * 自動編集の判断(`project.autoEdit`)があればそれをそのまま戻す。無い古い企画では、判定は簡易の点数にし、
 * 今の本編に残っている場面を「残す」、無い場面を「落とす」と手で決めたものとして扱う(何も変えずに
 * 作り直したら同じ場面になるように。手で残した場面・AI の判定で残した場面を落とさない)。
 * 同期と文字起こしが無い企画(手で作った企画)なら null
 */
export function restorePipelineFromProject(
  project: Project,
  fallbackKind: EpisodeKind
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
  const saved = project.autoEdit
  const kind = saved?.kind ?? fallbackKind
  const hype = saved?.hype ?? []

  // 構成の場面は、文字起こしと同期の情報から同じように切り直せる(声の盛り上がりは保存したもの)
  const scenes = scenesFor(project, info, { kind, ...(saved?.hype ? { hype } : {}) })
  const sceneIds = new Set(scenes.map((sc) => sc.id))
  const sameScenes =
    saved !== undefined &&
    saved.scenes.length === scenes.length &&
    saved.scenes.every(
      (x, i) =>
        x.id === scenes[i].id &&
        Math.abs(x.start - scenes[i].start) < 1e-3 &&
        Math.abs(x.end - scenes[i].end) < 1e-3
    )
  const heuristic = heuristicJudgements(scenes, kind)
  // 保存した判定を場面の ID で当てる(文字起こしを直して場面が変わったら、無い場面は簡易の点数)
  const judgedBy = (list: readonly { sceneId: string }[] | undefined): SceneJudgement[] => {
    const byId = new Map((list ?? []).map((j) => [j.sceneId, j]))
    return heuristic.map((h) => (byId.get(h.sceneId) as SceneJudgement | undefined) ?? h)
  }
  const judgements = saved ? judgedBy(saved.judgements) : heuristic
  const planJudgements = saved?.planJudgements ? judgedBy(saved.planJudgements) : null
  const judgeSource = saved?.judgeSource ?? 'heuristic'
  if (!saved)
    missing.push(
      '古い形式の企画のため、構成の判定(AI の判定)は企画に残っていません。簡易の点数で表示し、今の本編に残っている場面を「残す」、無い場面を「落とす」に固定しています(チェックで変えられます)'
    )
  else if (!sameScenes)
    missing.push(
      '保存した後で文字起こしが変わったため、場面の区切りが変わりました。前と同じ場面の判定・残す/落とすは引き継ぎ、新しい場面は簡易の点数にしています'
    )

  // 残した場面: 保存したもの。無ければ今の本編に残っている所から読み取る
  // (間を詰めた分があるので、3割以上残っていれば残した)
  const spans = project.clips.length > 0 ? spansOfClips(project.clips, info) : []
  const fromTimeline = scenes
    .filter((sc) => keptSeconds(sc, spans) >= Math.max(0.5, (sc.end - sc.start) * 0.3))
    .map((sc) => sc.id)
  const keptIds = saved?.keptIds ? saved.keptIds.filter((id) => sceneIds.has(id)) : fromTimeline
  const keep: Record<string, boolean> = {}
  if (saved) {
    for (const [id, v] of Object.entries(saved.keep)) if (sceneIds.has(id)) keep[id] = v
  } else if (project.clips.length > 0 && project.roughCutAuto) {
    for (const sc of scenes) keep[sc.id] = keptIds.includes(sc.id)
  }
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
  const effects = saved?.effects ?? []
  // 置くと決めたもの: 保存したもの。古い企画では、今置いてある演出テロップ(作り直しでも置き直す)
  const effectChosen = saved
    ? saved.effectChosen
    : [...new Set(effectTelops.map((o) => o.effectId!))]
  const sync = saved?.sync

  const steps: RestoredPipeline['steps'] = {
    ingest: done(`カメラ ${cameras.length} 台 · マイク ${mics.length} 本`),
    sync: done(sync ? `${sync.placed}/${sync.total} 本を同期` : `${info.files.length} 本を同期`),
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
      `場面 ${scenes.length} · 見どころ ${(planJudgements ?? judgements).filter((j) => j.kind === 'highlight').length} · 不要 ${(planJudgements ?? judgements).filter((j) => j.kind === 'unneeded').length}${judgeSource === 'ai' ? ' · AI' : ' · 簡易'}${saved ? '' : '(開き直した企画から)'}`
    ),
    cut: roughCut ? done(`${spans.length} 区間`) : unknown,
    angles: roughCut ? done(`ショット ${project.clips.length}`) : unknown,
    placement: speechTelops > 0 ? done(`発言テロップ ${speechTelops}`) : unknown,
    // AI に提案を頼んだ回は「済み」(作り直しでは同じ提案を置き直す)。頼んでいなければ「済み」にしない
    // (済みにすると、AI を使える設定にしても二度と頼まない)。古い企画は提案の一覧が残っていないので、
    // 作り直しでは今置いてある演出テロップを置き直す
    effects: saved?.effectsAsked
      ? done(`提案 ${effects.length} · 置いている ${effectChosen.length}`)
      : effects.length > 0 || effectTelops.length > 0
        ? {
            state: 'wait',
            percent: 0,
            note: saved
              ? `AI を使わない提案 ${effects.length} · 置いている ${effectChosen.length}`
              : `置いた演出テロップ ${effectTelops.length}(提案の一覧は古い形式の企画に残りません)`
          }
        : unknown,
    sound: autoSound ? done() : unknown
  }
  if (!saved && effectTelops.length > 0)
    missing.push(
      '古い形式の企画のため、演出テロップの提案の一覧は残っていません。置いてある演出テロップはタイムラインにあり、「仮編集を作り直す」でもそのまま置き直します(AI を使う設定なら提案し直し、人が直したものは残します)'
    )
  if (!sync)
    missing.push(
      '同期の詳しい結果(照らし合わせた組・時計のずれ・処理時間)は企画に残っていません。素材の位置は企画の同期の情報から表示しています'
    )
  return {
    steps,
    scenes,
    judgements,
    planJudgements,
    judgeSource,
    hype,
    keep,
    targetMinutes: saved?.targetMinutes ?? 0,
    editNote: saved?.editNote ?? '',
    effects,
    effectChosen,
    roughCut,
    missing,
    legacy: !saved
  }
}

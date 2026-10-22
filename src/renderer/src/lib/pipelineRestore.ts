import type { Project, TextOverlay } from '@shared/types'
import type { EpisodeKind } from '@shared/structure/kind'
import { heuristicJudgements, type Scene, type SceneJudgement } from '@shared/structure/scenes'
import type { HypeMoment } from '@shared/structure/hype'
import type { EffectProposal } from '@shared/telop/effects'
import type { EditPolicy } from '@shared/structure/kind'
import { spansOfClips } from '@shared/roughCut/overrides'
import { cutSignature } from '@shared/autoEdit'
import { autoKeptScenes, scenesFor } from './roughCutPlan'

type StepState = 'wait' | 'run' | 'done' | 'error' | 'skipped'

/** 開き直した企画から、自動編集の画面の状態を作り直した結果 */
export interface RestoredPipeline<Id extends string = string> {
  steps: Partial<Record<Id, { state: StepState; percent: number; note?: string }>>
  scenes: Scene[]
  judgements: SceneJudgement[]
  planJudgements: SceneJudgement[] | null
  judgeSource: 'ai' | 'heuristic'
  hype: HypeMoment[]
  /** 手で決めた残す / 落とす(保存した判断) */
  keep: Record<string, boolean>
  /** 作り直しのたびの残した場面(`AutoEditDecisions.builtKept`。今の場面の ID に直したもの) */
  builtKept: { cut: string; keptIds: string[] }[]
  /** 人が直した演出テロップで提案の一覧に無いもの(共通の時刻) */
  carriedTelops: Omit<TextOverlay, 'id'>[]
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
  /** 自動編集の判断が残っていない古い企画(前の版で保存した)を開いて、まだ作り直していないか */
  legacy: boolean
}

const UNKNOWN = '開き直した企画のため分かりません'

/** 古い形式の企画を開いたときの案内(作り直すまで出す) */
export const LEGACY_NOTE =
  'この企画は前の版で保存されたため、手で決めた残す/落とす(と AI の判定)は残っていません。「仮編集を作り直す」と、残す場面は自動の選び方で選び直します(手で詰めた・消した所は守られます)。画面のチェックは作り直したときに残す場面(の見込み)です。落としたい場面はチェックを外してから作り直してください'

/**
 * 前の場面の区切り(`prev`)から、今の場面(`next`)へ、時刻がほぼ同じ(重なりが長いほうの 8 割以上)場面の
 * 対応を作る(今の場面の ID → 前の場面の ID)。場面の ID は番号なので、区切りが変わると同じ ID が別の
 * 場面を指す。ID だけで当てると、判定・残す/落とすが別の場面に付く
 */
export function matchScenesByTime(
  prev: readonly { id: string; start: number; end: number }[],
  next: readonly { id: string; start: number; end: number }[]
): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const n of next) {
    let best: { id: string; overlap: number } | null = null
    for (const p of prev) {
      if (used.has(p.id)) continue
      const overlap = Math.min(n.end, p.end) - Math.max(n.start, p.start)
      const longer = Math.max(n.end - n.start, p.end - p.start)
      if (longer > 0 && overlap >= longer * 0.8 && (!best || overlap > best.overlap))
        best = { id: p.id, overlap }
    }
    if (best) {
      out.set(n.id, best.id)
      used.add(best.id)
    }
  }
  return out
}

/** 場面ごとの印(残す / 落とす)を、前の場面から時刻の対応で今の場面へ移す */
export function remapSceneFlags(
  flags: Readonly<Record<string, boolean>>,
  match: ReadonlyMap<string, string>
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [id, prevId] of match) if (flags[prevId] !== undefined) out[id] = flags[prevId]
  return out
}

/**
 * 保存した企画(同期の情報・文字起こし・仮編集・テロップ・自動編集の判断)から、自動編集の画面の状態
 * (工程の済み・構成の場面・判定・残す/落とす・仕上がりの長さ・演出テロップの提案・仮編集の要約)を作り直す。
 * 自動編集の判断(`project.autoEdit`)があればそれを戻す(場面の区切りが変わっていたら、時刻がほぼ同じ場面
 * だけ)。無い古い企画(前の版で保存したもの)では、手で決めた残す/落とすは引き継げない。判定は簡易の
 * 点数にし、残す場面は作り直したときの自動の選び方(`autoKeptScenes`)で出す。今の本編から残した場面を
 * 推し量ることはしない(推し量ると、場面の入れ替え・一部だけ残す・差し込みのたびに読み違えた)。
 * 手で詰めた・消した所は企画の本編と前に組んだ本編に残っているので、作り直しでも守られる。
 * 同期と文字起こしが無い企画(手で作った企画)なら null
 */
export function restorePipelineFromProject(
  project: Project,
  fallbackKind: EpisodeKind,
  /** 古い形式の企画で、作り直したら残す場面を出すのに使う(作り直すときと同じ種類・方針) */
  plan: { kind?: EpisodeKind; policy?: EditPolicy } = {}
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
  // 保存した場面と今の場面の対応(時刻がほぼ同じもの)。場面の区切りが変わったら、対応の無い場面は簡易の点数
  const match = matchScenesByTime(saved?.scenes ?? [], scenes)
  const judgedBy = (list: readonly SceneJudgement[] | undefined): SceneJudgement[] => {
    const byId = new Map((list ?? []).map((j) => [j.sceneId, j]))
    return heuristic.map((h) => {
      const prevId = match.get(h.sceneId)
      const j = prevId !== undefined ? byId.get(prevId) : undefined
      return j ? { ...j, sceneId: h.sceneId } : h
    })
  }
  const judgements = saved ? judgedBy(saved.judgements) : heuristic
  const planJudgements = saved?.planJudgements ? judgedBy(saved.planJudgements) : null
  const judgeSource = saved?.judgeSource ?? 'heuristic'
  const legacy = !saved || saved.legacyPending === true
  if (legacy) missing.push(LEGACY_NOTE)
  if (saved && !sameScenes)
    missing.push(
      '保存した時と場面の区切りが変わりました(文字起こし・同期を直した など)。時刻がほぼ同じ場面だけ前の判定・残す/落とすを引き継ぎ、それ以外の場面は簡易の点数・自動の選び方にしています'
    )

  // 残した場面: 保存したもの。無い古い企画では、作り直したら残す場面(自動の選び方)。
  // 今の本編から推し量らない
  const spans = project.clips.length > 0 ? spansOfClips(project.clips, info) : []
  const toNow = (ids: readonly string[]): string[] => {
    const set = new Set(ids)
    return scenes.map((sc) => sc.id).filter((id) => set.has(match.get(id) ?? ''))
  }
  const keptIds = saved?.keptIds
    ? toNow(saved.keptIds)
    : autoKeptScenes(
        scenes,
        judgements,
        plan.kind ?? kind,
        plan.policy,
        (saved?.targetMinutes ?? 0) * 60
      )
  const keep = saved ? remapSceneFlags(saved.keep, match) : {}
  // 作り直しのたびの残した場面。古い企画では、今の本編を組んだ時の残した場面が分からないので、
  // 画面に出した残す場面(手で決めた残す/落とすの元)を今の組んだ本編のものとする
  const autoSig = cutSignature(project.roughCutAuto)
  const builtKept = saved?.builtKept
    ? saved.builtKept.map((b) => ({ cut: b.cut, keptIds: toNow(b.keptIds) }))
    : autoSig && project.clips.length > 0
      ? [{ cut: autoSig, keptIds }]
      : []
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
    builtKept,
    carriedTelops: saved?.carriedTelops ?? [],
    targetMinutes: saved?.targetMinutes ?? 0,
    editNote: saved?.editNote ?? '',
    effects,
    effectChosen,
    roughCut,
    missing,
    legacy
  }
}

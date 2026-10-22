import type { EffectKind, EffectProposal } from './telop/effects'
import type { HypeMoment } from './structure/hype'
import type { EpisodeKind } from './structure/kind'
import type { SceneJudgement, SceneKind } from './structure/scenes'
import type { PlacementMethod } from './sync/solve'

/** 同期の結果の要約(自動編集の画面の「同期の結果」に出す数字)。同期の報告そのものは企画に残らない */
export interface SyncSummary {
  /** 同期できた素材 / 同期にかけた素材 */
  placed: number
  total: number
  /** 信頼できた照らし合わせの組 / 照らし合わせた組 */
  reliablePairs: number
  pairs: number
  /** 時計のずれの最大(ppm)。測れなければ無し */
  maxDriftPpm?: number
  elapsedMs: number
  /** 素材(企画の素材の ID)ごとの、どうやって位置を決めたか */
  methods?: Record<string, PlacementMethod>
}

/**
 * 自動編集の判断(企画のファイルに残す)。開き直したときに、自動編集の画面と「仮編集を作り直す」の
 * 元をそのまま戻すのに使う。古い企画には無い(無ければ今の本編から読み取る)
 */
export interface AutoEditDecisions {
  /** 場面を切ったときの番組の種類と、声の盛り上がり(同じ場面に切り直すのに使う) */
  kind?: EpisodeKind
  hype?: HypeMoment[]
  /** 判定した場面の区切り(切り直した場面が同じかを確かめる) */
  scenes: { id: string; start: number; end: number }[]
  judgements: SceneJudgement[]
  /** 仮編集で場面を選ぶのに使った判定(見どころを点数の判定に置き換えたとき) */
  planJudgements?: SceneJudgement[]
  judgeSource: 'ai' | 'heuristic'
  /** 画面で手で決めた残す / 落とす */
  keep: Record<string, boolean>
  /** 仕上がりの長さ(分。0 なら決めない)と編集の方針 */
  targetMinutes: number
  editNote: string
  /** 今の仮編集で残した場面 */
  keptIds?: string[]
  /** 演出テロップの提案の一覧と、置くと決めたもの */
  effects: EffectProposal[]
  effectChosen: string[]
  /** AI に演出テロップの提案を頼んだか(頼んでいれば、作り直しでは同じ提案を置き直す) */
  effectsAsked?: boolean
  sync?: SyncSummary
}

const SCENE_KINDS: readonly SceneKind[] = ['highlight', 'normal', 'unneeded']
const METHODS: readonly PlacementMethod[] = ['audio', 'clock', 'reference', 'none']

const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown): v is string => typeof v === 'string'

function judgementsOf(raw: unknown): SceneJudgement[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (j): j is SceneJudgement =>
      isObj(j) &&
      str(j.sceneId) &&
      num(j.score) &&
      SCENE_KINDS.includes(j.kind as SceneKind) &&
      str(j.reason)
  )
}

function syncOf(raw: unknown): SyncSummary | undefined {
  if (!isObj(raw)) return undefined
  if (![raw.placed, raw.total, raw.reliablePairs, raw.pairs, raw.elapsedMs].every(num))
    return undefined
  const methods: Record<string, PlacementMethod> = {}
  if (isObj(raw.methods))
    for (const [k, v] of Object.entries(raw.methods))
      if (METHODS.includes(v as PlacementMethod)) methods[k] = v as PlacementMethod
  return {
    placed: raw.placed as number,
    total: raw.total as number,
    reliablePairs: raw.reliablePairs as number,
    pairs: raw.pairs as number,
    elapsedMs: raw.elapsedMs as number,
    ...(num(raw.maxDriftPpm) ? { maxDriftPpm: raw.maxDriftPpm } : {}),
    ...(Object.keys(methods).length > 0 ? { methods } : {})
  }
}

/** 企画のファイルから読んだ自動編集の判断を整える(壊れた項目は捨てる。形が違えば無し) */
export function normalizeAutoEdit(raw: unknown): AutoEditDecisions | undefined {
  if (!isObj(raw) || !Array.isArray(raw.scenes)) return undefined
  const scenes = raw.scenes
    .filter(
      (s): s is Record<string, unknown> => isObj(s) && str(s.id) && num(s.start) && num(s.end)
    )
    .map((s) => ({ id: s.id as string, start: s.start as number, end: s.end as number }))
  const keep: Record<string, boolean> = {}
  if (isObj(raw.keep))
    for (const [k, v] of Object.entries(raw.keep)) if (typeof v === 'boolean') keep[k] = v
  const effects = Array.isArray(raw.effects)
    ? raw.effects.filter(
        (e): e is EffectProposal =>
          isObj(e) &&
          str(e.id) &&
          str(e.afterLineId) &&
          str(e.kind as EffectKind) &&
          str(e.text) &&
          num(e.confidence) &&
          (e.at === undefined || num(e.at))
      )
    : []
  const effectChosen = Array.isArray(raw.effectChosen) ? raw.effectChosen.filter(str) : []
  const hype = Array.isArray(raw.hype)
    ? raw.hype.filter(
        (h): h is HypeMoment => isObj(h) && num(h.start) && num(h.end) && num(h.riseDb)
      )
    : undefined
  const planJudgements = Array.isArray(raw.planJudgements)
    ? judgementsOf(raw.planJudgements)
    : undefined
  const sync = syncOf(raw.sync)
  return {
    ...(raw.kind === 'location' || raw.kind === 'game' ? { kind: raw.kind } : {}),
    ...(hype ? { hype } : {}),
    scenes,
    judgements: judgementsOf(raw.judgements),
    ...(planJudgements ? { planJudgements } : {}),
    judgeSource: raw.judgeSource === 'ai' ? 'ai' : 'heuristic',
    keep,
    targetMinutes: num(raw.targetMinutes) ? Math.max(0, raw.targetMinutes) : 0,
    editNote: str(raw.editNote) ? raw.editNote : '',
    ...(Array.isArray(raw.keptIds) ? { keptIds: raw.keptIds.filter(str) } : {}),
    effects: effects.map((e) => ({ ...e, reason: str(e.reason) ? e.reason : '' })),
    effectChosen,
    ...(raw.effectsAsked === true ? { effectsAsked: true } : {}),
    ...(sync ? { sync } : {})
  }
}

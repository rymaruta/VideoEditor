import type { LengthDropBy } from './structure/scenes'
import type { EffectKind, EffectProposal } from './telop/effects'
import type { HypeMoment } from './structure/hype'
import type { SceneMove } from './structure/boundaryAi'
import type { EpisodeKind } from './structure/kind'
import type { SceneJudgement, SceneKind } from './structure/scenes'
import type { PlacementMethod } from './sync/solve'
import type { TextOverlay } from './types'
import type { CameraSeg } from './roughCut/overrides'

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
 * 元をそのまま戻すのに使う。古い企画(10/09 版など)には無い(無ければ手で決めた残す/落とすは引き継げず、
 * 作り直すと自動の選び方になる。今の本編から推し量ることはしない)。
 * b4cd4d9〜ac0e4c8 の版で保存した企画には `timelineKeep`(今の本編から読み取った残す/落とす)があるが、
 * 読むときに捨てる
 */
export interface AutoEditDecisions {
  /** 場面を切ったときの番組の種類と、声の盛り上がり(同じ場面に切り直すのに使う) */
  kind?: EpisodeKind
  hype?: HypeMoment[]
  /**
   * AI が直した場面の区切り(`planSceneMoves`)。開き直しでは AI に聞き直さず、公開中の版と同じ切り方で
   * 切った場面にこれを当てる(作った時と同じ区切りにする)。無ければ直していない
   */
  sceneMoves?: SceneMove[]
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
  /**
   * 作り直しのたびの、残した場面(新しいものが後ろ)。`cut` はその時に組んだ本編(`roughCutAuto`)の印
   * (`cutSignature`)。次に作り直すとき、今の `roughCutAuto` と同じ印の回の残した場面と比べ、
   * 「落とす → 残す」に変わった場面だけ、その中の手の削りを取り消す。取り消し(Ctrl+Z)で本編が前の回に
   * 戻っても、その回の残した場面と比べられる
   */
  builtKept?: { cut: string; keptIds: string[] }[]
  /**
   * 前回の作り直しの後に、画面でチェック(残す / 落とす)を触った場面。人が丸ごと消した「残す」場面は、
   * ここにあるときだけ作り直しで戻す(付け直さなければ、丸ごと消したのも手の削りとして守る)
   */
  keepTouched?: string[]
  /** 古い形式の企画を開いて、まだ作り直していない(手で決めた残す/落とすは前の版のものが残っていない) */
  legacyPending?: boolean
  /** 演出テロップの提案の一覧と、置くと決めたもの */
  effects: EffectProposal[]
  effectChosen: string[]
  /** AI に演出テロップの提案を頼んだか(頼んでいれば、作り直しでは同じ提案を置き直す) */
  effectsAsked?: boolean
  /**
   * 人が直した演出テロップのうち提案の一覧に無いもの(時刻は共通の時刻)。場面を落とすと本編から消えるので、
   * 覚えておいて、場面を戻したら置き直す
   */
  carriedTelops?: Omit<TextOverlay, 'id'>[]
  sync?: SyncSummary
  /**
   * カメラの色合わせの工程が済んだときの結果の文。合わせる必要のあるカメラが無かった回は素材に色合わせの
   * 印(`colorMatch`)が残らないので、開き直すと「待機 · 分かりません」と出ていた。済んだことを覚えておく
   */
  colorDone?: string
  /**
   * SE・BGM・CG の工程の終わり方と結果の文。番組素材フォルダが未設定で省いた回・置く物が無かった回は
   * 自動のトラックが残らないので、開き直すと「待機」になり「93% · 13 / 14 工程」と出ていた(試し編集 第2回)
   */
  soundDone?: { state: 'done' | 'skipped'; note: string }
  /**
   * 演出テロップの提案を AI に頼まずに省いたときの結果の文(AI を使わない設定など)。開き直しても「省略」と出す
   * (「済み」にはしない。AI を使える設定にして作り直せば頼む)
   */
  effectsSkipped?: string
  /**
   * 今の仮編集で場面を選んだときの方針(落とした理由・数を、作った時の方針で出す。作り直す前に設定を
   * 変えても、文言が今の仮編集とずれないように)
   */
  dropBasis?: DropBasis
  /**
   * 範囲だけ自動編集した所(共通の時刻。新しいものが後ろ)。全体を作り直すと、ここも作り直されることを
   * 作り直す前に知らせる(残したい所はロックする)。全体を作り直したら空にする
   */
  rangeRuns?: RangeRun[]
}

/** 範囲だけ自動編集した1回 */
export interface RangeRun {
  /** 共通の時刻の窓 */
  start: number
  end: number
  /** 当てた時(ms) */
  at: number
}

/** 覚えておく範囲の自動編集の回数 */
export const RANGE_RUNS_MAX = 20

/** 覚えておく作り直しの回数(取り消しで戻れる回数よりは少ないが、普段の行き来には足りる) */
export const BUILT_KEPT_MAX = 20

/** 組んだ本編(共通の時刻の区間とカメラ)の印。同じ本編なら同じ印 */
export function cutSignature(segs: readonly CameraSeg[] | undefined): string | undefined {
  if (!segs || segs.length === 0) return undefined
  // FNV-1a(32 ビット)。区間は 1ms に丸める
  let h = 0x811c9dc5
  const text = segs.map((s) => `${s.start.toFixed(3)},${s.end.toFixed(3)},${s.cameraId}`).join(';')
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${segs.length}:${h.toString(16)}`
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
  const flags = (r: unknown): Record<string, boolean> => {
    const out: Record<string, boolean> = {}
    if (isObj(r)) for (const [k, v] of Object.entries(r)) if (typeof v === 'boolean') out[k] = v
    return out
  }
  const keep = flags(raw.keep)
  // 前の版(b4cd4d9〜ac0e4c8)の `timelineKeep`(今の本編から読み取った残す/落とす)は読み捨てる。
  // その版では残す場面をこれで決めていたので、手で決めた残す/落とすが残っていない古い企画と同じに扱う
  // (残した場面 `keptIds` も、今の本編から読み取ったものなので使わない)
  const readFromTimeline = isObj(raw.timelineKeep) && Object.keys(raw.timelineKeep).length > 0
  const builtKept = Array.isArray(raw.builtKept)
    ? raw.builtKept
        .filter(
          (b): b is Record<string, unknown> => isObj(b) && str(b.cut) && Array.isArray(b.keptIds)
        )
        .map((b) => ({ cut: b.cut as string, keptIds: (b.keptIds as unknown[]).filter(str) }))
        .slice(-BUILT_KEPT_MAX)
    : []
  const keepTouched = Array.isArray(raw.keepTouched) ? raw.keepTouched.filter(str) : []
  const carriedTelops = Array.isArray(raw.carriedTelops)
    ? raw.carriedTelops.filter(
        (o): o is Omit<TextOverlay, 'id'> =>
          isObj(o) &&
          str(o.effectId) &&
          str(o.text) &&
          num(o.startTime) &&
          num(o.endTime) &&
          o.endTime > o.startTime &&
          isObj(o.style)
      )
    : []
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
  // AI が直した場面の区切り(時刻の組だけ。当てられるかは開き直しで `applySceneMoves` が確かめる)
  const sceneMoves = Array.isArray(raw.sceneMoves)
    ? raw.sceneMoves
        .filter((m): m is Record<string, unknown> => isObj(m) && num(m.at) && num(m.to))
        .map((m) => ({ at: m.at as number, to: m.to as number }))
    : []
  const planJudgements = Array.isArray(raw.planJudgements)
    ? judgementsOf(raw.planJudgements)
    : undefined
  const sync = syncOf(raw.sync)
  const rangeRuns = Array.isArray(raw.rangeRuns)
    ? raw.rangeRuns
        .filter(
          (r): r is Record<string, unknown> =>
            isObj(r) && num(r.start) && num(r.end) && r.end > r.start && num(r.at)
        )
        .map((r) => ({ start: r.start as number, end: r.end as number, at: r.at as number }))
        .slice(-RANGE_RUNS_MAX)
    : []
  return {
    ...(raw.kind === 'location' || raw.kind === 'game' ? { kind: raw.kind } : {}),
    ...(hype ? { hype } : {}),
    ...(sceneMoves.length > 0 ? { sceneMoves } : {}),
    scenes,
    judgements: judgementsOf(raw.judgements),
    ...(planJudgements ? { planJudgements } : {}),
    judgeSource: raw.judgeSource === 'ai' ? 'ai' : 'heuristic',
    keep,
    targetMinutes: num(raw.targetMinutes) ? Math.max(0, raw.targetMinutes) : 0,
    editNote: str(raw.editNote) ? raw.editNote : '',
    ...(Array.isArray(raw.keptIds) && !readFromTimeline
      ? { keptIds: raw.keptIds.filter(str) }
      : {}),
    ...(builtKept.length > 0 ? { builtKept } : {}),
    ...(keepTouched.length > 0 ? { keepTouched } : {}),
    ...(raw.legacyPending === true || readFromTimeline ? { legacyPending: true } : {}),
    effects: effects.map((e) => ({ ...e, reason: str(e.reason) ? e.reason : '' })),
    effectChosen,
    ...(raw.effectsAsked === true ? { effectsAsked: true } : {}),
    ...(carriedTelops.length > 0 ? { carriedTelops } : {}),
    ...(sync ? { sync } : {}),
    ...(str(raw.colorDone) ? { colorDone: raw.colorDone } : {}),
    ...(typeof raw.effectsSkipped === 'string' ? { effectsSkipped: raw.effectsSkipped } : {}),
    ...(normalizeDropBasis(raw.dropBasis) ? { dropBasis: normalizeDropBasis(raw.dropBasis)! } : {}),
    ...(raw.soundDone &&
    typeof raw.soundDone === 'object' &&
    ((raw.soundDone as { state?: unknown }).state === 'done' ||
      (raw.soundDone as { state?: unknown }).state === 'skipped')
      ? {
          soundDone: {
            state: (raw.soundDone as { state: 'done' | 'skipped' }).state,
            note: str((raw.soundDone as { note?: unknown }).note)
              ? (raw.soundDone as { note: string }).note
              : ''
          }
        }
      : {}),
    ...(rangeRuns.length > 0 ? { rangeRuns } : {})
  }
}

/** 仮編集で場面を選んだときの方針(`AutoEditDecisions.dropBasis`) */
export interface DropBasis {
  /** 「不要」を落とした */
  dropUnneeded: boolean
  /** 長さの目標(秒。0 は目標を使わなかった) */
  targetSec: number
  /** 点数の下限で落としたときの下限(下げた後の値)。使わなければ null */
  minScore: number | null
  /** 下限を越える場面が無く、下限を下げた */
  relaxed: boolean
  /** 見どころが多すぎて、場面を選ぶ判定を点数の判定に置き換えた */
  replaced: boolean
  /** 長さに合わせて落とした場面を、何で選んだか(場面の id → `LengthDropBy`) */
  lengthBy?: Record<string, LengthDropBy>
}

export function normalizeDropBasis(raw: unknown): DropBasis | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.dropUnneeded !== 'boolean' || typeof r.targetSec !== 'number') return undefined
  if (!Number.isFinite(r.targetSec)) return undefined
  return {
    dropUnneeded: r.dropUnneeded,
    targetSec: Math.max(0, r.targetSec),
    minScore: typeof r.minScore === 'number' && Number.isFinite(r.minScore) ? r.minScore : null,
    relaxed: r.relaxed === true,
    replaced: r.replaced === true,
    ...(lengthByOf(r.lengthBy) ? { lengthBy: lengthByOf(r.lengthBy)! } : {})
  }
}

const LENGTH_BY: readonly LengthDropBy[] = ['score', 'cues', 'beside', 'edge', 'fit', 'refit']

function lengthByOf(raw: unknown): Record<string, LengthDropBy> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, LengthDropBy> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>))
    if (LENGTH_BY.includes(v as LengthDropBy)) out[k] = v as LengthDropBy
  return Object.keys(out).length > 0 ? out : undefined
}

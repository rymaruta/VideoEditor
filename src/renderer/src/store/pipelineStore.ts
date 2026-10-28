import { speechLook } from '@shared/telop/styles'
import type { HypeMoment } from '@shared/structure/hype'
import type { EpisodeKind } from '@shared/structure/kind'
import type { ShortOptions } from '@shared/structure/shorts'
import { buildShortProject, shortWindowsFor } from '../lib/gameShorts'
import { prepareTelopLayerForExport } from '../lib/telopRaster'
import { safeFileBaseName } from '@shared/fileName'
import type { CameraRole, TrackRole } from '@shared/ingest/tracks'
import { countEvents } from '@shared/events/audioEvents'
import {
  bubbleProposals,
  chapterProposals,
  clockProposals,
  laughProposals
} from '@shared/telop/autoEffects'
import { isImagePath } from '@shared/mediaExtensions'
import { stillAssetFrom } from '../lib/stillAsset'
import {
  coverageOfClips,
  hasOverrides,
  releaseOverridesForScenes,
  spansOfClips,
  updateOverrides,
  type CameraSeg
} from '@shared/roughCut/overrides'
import { planCg, type PlacedCg } from '@shared/finish/cg'
import {
  fallbackMood,
  planBgm,
  planSoundEffects,
  timelineRangeOf,
  type BgmMood,
  type PlacedSound
} from '@shared/finish/sound'
import { planCameraColors } from '../lib/colorMatchPlan'
import { COLOR_VERDICT_TEXT, describeColorMatch, type ColorMatchVerdict } from '@shared/color/match'
import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { FootageScan, FootageSource, ProbedFile, SourceKind } from '@shared/ingest/classify'
import type { SyncInputFile, SyncReport } from '@shared/sync/report'
import type { PlacementMethod } from '@shared/sync/solve'
import { buildMulticamLayout } from '@shared/sync/multicamLayout'
import type { MediaAsset } from '@shared/types'
import {
  isUntouchedAuto,
  onProjectSwitch,
  applyWhenNotTrying,
  rangedEditProject,
  sameExceptAutoEdit,
  withTrialWrite,
  useProjectStore,
  withRangedSounds
} from './projectStore'
import { overallPercent, reportBusy } from '../lib/busyReporter'
import { useSettingsStore } from './settingsStore'
import { parseDictionary } from '@shared/telop/polish'
import { usePresetStore } from './presetStore'
import type { Project, TextOverlay } from '@shared/types'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Scene, SceneJudgement } from '@shared/structure/scenes'
import {
  cameraRange,
  judgeScenes,
  loadActivity,
  effectLines,
  effectOverlays,
  planRoughCut,
  proposeEffects,
  scenesFor,
  hypeMomentsFor,
  peakSpans,
  placedAutoTelops,
  levelOf,
  releaseRanges,
  sceneOfSpan
} from '../lib/roughCutPlan'
import { placeTelopsAvoidingFaces, placeTelopsAvoidingHud } from '../lib/telopPlacement'
import {
  LEGACY_NOTE,
  isLegacyNote,
  matchScenesByTime,
  remapSceneFlags,
  restorePipelineFromProject
} from '../lib/pipelineRestore'
import {
  BUILT_KEPT_MAX,
  RANGE_RUNS_MAX,
  cutSignature,
  type AutoEditDecisions,
  type RangeRun,
  type SyncSummary
} from '@shared/autoEdit'
import {
  clipScenesToWindow,
  clipTimes,
  commonWindowOf,
  overridesWithPinned,
  overridesWithin,
  pinOverrides,
  matchLockBlocks,
  type TimelineRange
} from '@shared/roughCut/range'
import { subtractRanges, type CutOverrides, type Range } from '@shared/roughCut/overrides'
import { frameSeconds } from '@shared/frameRate'
import { snapRangeBoundaries } from '../lib/timelineRange'
import {
  addRangedVariant,
  mainLength,
  rangedEditBlockedReason,
  rangedVariantSpecs,
  summarizeRangedEdit,
  type RangedEditOptions,
  type RangedPreview,
  type RangedPrepareResult,
  type RangedSummary,
  type RangedVariantId,
  type RangedVariantSpec,
  type RangedVariantsResult
} from '../lib/rangedAutoEdit'
import { heuristicJudgements, indistinctJudgements } from '@shared/structure/scenes'
import { prepareVerticalFill } from '../lib/verticalFraming'
import {
  AI_EFFECT_KINDS,
  AUTO_PLACE_CONFIDENCE,
  nameProposals,
  type EffectProposal
} from '@shared/telop/effects'
import { roughTimelineAt, type RoughCut } from '@shared/roughCut/build'
import { mapTimelineRange, timelineMapping } from '@shared/roughCut/follow'
import { formatIpcError } from '../lib/ipcError'
import { cancelAiRequests } from '../lib/ai'
import {
  AUTO_TRACK_NAME,
  mixCarriesVoice,
  mixHasUnaccountedSound,
  mixResidual,
  STREAMER_SPEAKER
} from '@shared/ingest/tracks'
export { STREAMER_SPEAKER }
import { emitMenuCommand } from '../lib/menuCommands'
import {
  activityMask,
  detectTurns,
  placeEnvelope,
  coveredBy,
  sameVoice,
  TURN_RATE,
  type MicTrack
} from '@shared/diarize/micTurns'
import { turnsToJobs } from '@shared/diarize/turnJobs'
import {
  asrStepProgress,
  hallucinatedIndices,
  isLikelyHallucination,
  joinSplitNumbers,
  type AsrDevice,
  type AsrJobResult,
  type TranscriptUtterance
} from '@shared/transcript'

/**
 * 自動編集の工程(計画書 §5)の状態。「新しい回を作る」と「自動編集」の画面が同じものを見る。
 * 画面を閉じても工程は止まらない(状態はここにある)。
 *
 * 今ある工程: 取り込み・整理 → カメラの同期 → タイムラインに並べる → 話者の判定 → 文字起こし。
 * 構成・カット・アングルの切り替えなどは、できたものから順にここへ足していく。
 */

export type StepId =
  | 'ingest'
  | 'sync'
  | 'timeline'
  | 'color'
  | 'denoise'
  | 'speakers'
  | 'transcribe'
  | 'events'
  | 'structure'
  | 'cut'
  | 'angles'
  | 'placement'
  | 'effects'
  | 'sound'
export type StepState = 'wait' | 'run' | 'done' | 'error' | 'skipped'

export interface StepStatus {
  state: StepState
  percent: number
  note?: string
  /** 始めた時刻(ms)と、かかった時間(ms)。処理時間の記録に使う */
  startedAt?: number
  elapsedMs?: number
}

/** 画面で直せる振り分け。kind が skip なら使わない */
export interface EditableSource {
  id: string
  name: string
  kind: SourceKind | 'skip'
  /** カメラが主に映している出演者(マイクの名前)。全体なら undefined */
  subject?: string
  basis: string
  files: ProbedFile[]
  /** 取り出した音声トラックの役割(声・ゲーム音・全部入り) */
  trackRole?: TrackRole
  /** ゲーム実況のカメラの役割(ゲーム画面・顔カメラ) */
  cameraRole?: CameraRole
}

/** マイク1本の回の、話者の判定の結果に添える文(話者は分けない) */
export const SINGLE_MIC_NOTE = 'マイク1本では話者を分けられません'

export const STEPS: { id: StepId; label: string }[] = [
  { id: 'ingest', label: '取り込み・整理' },
  { id: 'sync', label: 'カメラ・マイクの同期' },
  { id: 'timeline', label: 'タイムラインに並べる' },
  { id: 'color', label: 'カメラの色合わせ' },
  { id: 'denoise', label: 'ピンマイクのノイズ除去' },
  { id: 'speakers', label: '話者の判定' },
  { id: 'transcribe', label: '文字起こし' },
  { id: 'events', label: '笑い・歓声の検出' },
  { id: 'structure', label: '構成(見どころ・不要な場面)' },
  { id: 'cut', label: 'カット(間を詰める)' },
  { id: 'angles', label: 'アングルの切り替え' },
  { id: 'placement', label: '発言テロップの配置(顔を避ける)' },
  { id: 'effects', label: '演出テロップの提案' },
  { id: 'sound', label: 'SE・BGM・CG' }
]

interface PipelineState {
  root: string | null
  scan: FootageScan | null
  /** 今の `scan` を、音声トラックを分けて読んだか(ゲーム実況)。番組の種類と合わなければ読み直す */
  scanTracks: boolean | null
  sources: EditableSource[]
  steps: Record<StepId, StepStatus>
  report: SyncReport | null
  /** 同期にかけた素材(ID → 素材)。結果の表示に使う */
  syncedFiles: SyncInputFile[]
  log: { time: number; text: string }[]
  /** 「このままでよい」とした要確認の印 */
  running: boolean
  screenOpen: boolean
  /** 自動編集の画面の見せ方: 工程の全体か、確認(要確認の一覧を大きく)。上の帯の「自動編集」「確認」 */
  screenView: 'auto' | 'review'
  /** 音声認識に使った計算装置(GPU / CPU) */
  asrDevice: AsrDevice | null
  /** 仕上がりの長さ(分)。0 なら決めない(不要な場面だけ落とす) */
  targetMinutes: number
  /** 構成の編集方針(AI に伝える) */
  editNote: string
  scenes: Scene[]
  judgements: SceneJudgement[]
  /** 仮編集で場面を選ぶのに使った判定(見どころを点数の判定に置き換えたとき)。無ければ `judgements` */
  planJudgements: SceneJudgement[] | null
  /** 場面の判定を AI でしたか、簡易の点数か */
  judgeSource: 'ai' | 'heuristic' | null
  /** 声の盛り上がり(ゲーム実況で測る)。仮編集を作り直すときも、山の前後に絞るのに使う */
  hype: HypeMoment[]
  /** 画面で手で決めた「残す / 落とす」 */
  keep: Record<string, boolean>
  /**
   * 作り直しのたびの残した場面と、その時に組んだ本編の印(`AutoEditDecisions.builtKept`)。
   * 削りの取り消しに渡す「残す」を、前回の残す/落とすからの変化で決めるのに使う(`releasedKeep`)
   */
  builtKept: { cut: string; keptIds: string[] }[]
  /**
   * 画面でチェック(残す / 落とす)を触って、まだ作り直しで使っていない場面
   * (`AutoEditDecisions.keepTouched`)。人が丸ごと消した「残す」場面は、付け直したとき(ここにあるか、
   * 使った作り直しを取り消したとき。`usedTouches`)だけ作り直しで戻す(`releasedKeep`)
   */
  keepTouched: string[]
  /** 人が直した演出テロップで提案の一覧に無いもの(共通の時刻)。場面を落として戻したときに置き直す */
  carriedTelops: Omit<TextOverlay, 'id'>[]
  /** 場面を切ったときの番組の種類(企画に覚えて、開き直したときに同じ場面に切り直す) */
  sceneKind: EpisodeKind | null
  /** 演出テロップの提案(AI)と、置くと決めたもの */
  effects: EffectProposal[]
  effectChosen: string[]
  /** 今の仮編集の、タイムラインと共通の時刻の対応(演出テロップを置き直すのに使う) */
  lastSpans: RoughCut['spans']
  /** 最後に置いた発言テロップ(吹き出しをやめたときに、その発言のものを戻す) */
  speechTelops: Omit<TextOverlay, 'id'>[]
  /** 演出テロップを置く/外す(すぐタイムラインに反映する) */
  setEffectChosen: (id: string, chosen: boolean) => void
  /** 顔の検出で、上下どちらに置いても顔に掛かった発言テロップ(要確認) */
  telopReviews: { startTime: number; text: string; key: string | null }[]
  /** 色を合わせられなかったカメラ(要確認に出す) */
  colorIssues: { name: string; verdict: Exclude<ColorMatchVerdict, 'matched' | 'same'> }[]
  /** ノイズ除去ができなかったピンマイク(要確認に出す) */
  /** ノイズ除去ができなかった素材(同じ名前の録音が別の録音機にあるので、素材の ID で見分ける) */
  denoiseFailures: { assetId?: string; fileName: string; error: string }[]
  /** 今の仮編集の要約 */
  roughCut: {
    keptIds: string[]
    kept: number
    dropped: number
    duration: number
    shots: number
    telops: number
  } | null
  setTargetMinutes: (minutes: number) => void
  setEditNote: (note: string) => void
  /** ログに1行足す(画面の操作の結果を残す) */
  addLog: (text: string) => void
  setKeep: (sceneId: string, keep: boolean | undefined) => void
  /** 構成の判定はそのままに、カット・アングル・仮編集を作り直す(残す/落とす・長さを変えたとき) */
  rebuildRoughCut: () => Promise<void>
  /** ショート(縦型)づくりの進み具合 */
  shorts: ShortsProgress
  /**
   * 見どころの山から縦型のショートを作り、`folder` に企画(.veproj)と動画(.mp4)を1本ずつ書く。
   * 書いた動画のパスを返す(区間が無ければ空)
   */
  makeShorts: (folder: string, options: ShortOptions) => Promise<string[]>

  setScreenOpen: (open: boolean) => void
  setScreenView: (view: 'auto' | 'review') => void
  scanFolder: (root: string) => Promise<void>
  updateSource: (
    id: string,
    patch: Partial<Pick<EditableSource, 'name' | 'kind' | 'subject' | 'trackRole' | 'cameraRole'>>
  ) => void
  runPipeline: () => Promise<void>
  cancel: () => void
  markReviewed: (key: string, reviewed: boolean) => void
  reset: () => void
  /** 自動編集の結果(構成・提案・要確認など)だけを捨てる。取り込んだフォルダは残す */
  resetResults: () => void
  /** 収録フォルダの読み取り(素材の整理・同期にかけた素材)を捨てる。別の企画を開いたとき */
  dropScan: () => void
  /**
   * 開き直した企画に残っている結果(同期・文字起こし・仮編集)から、工程の済み・構成・仮編集の要約を
   * 作り直す。開き直すと自動編集の画面が空(工程が全部「待機」・構成が空・ショートを作れない)だった
   */
  restoreFromProject: () => void
  /**
   * 開き直した企画から作り直した状態か。企画に残らず作り直せなかったもの(画面に出す)。
   * `legacy` は自動編集の判断が残っていない古い企画から読み取ったとき
   */
  restored: { missing: string[]; legacy: boolean } | null
  /** 範囲だけ自動編集した所(`AutoEditDecisions.rangeRuns`)。全体を作り直したら空にする */
  rangeRuns: RangeRun[]
  /**
   * 範囲を自動編集して当てた直後の見比べ(前/後を取り消し・やり直しで行き来する)。
   * 本編がそのどちらでもなくなったら閉じる
   */
  rangeReview: RangeReview | null
  closeRangeReview: () => void
  /** 範囲の自動編集の記録を入れ替えて企画に覚える(取り消し・やり直しで行き来させる) */
  setRangeRuns: (runs: RangeRun[]) => void
  /**
   * 選んだ範囲(タイムラインの秒)だけを自動で作り直す用意をする(企画には当てない)。
   * 境は静かな所・フレームへ寄せる。使えない・作れないときは理由を返す
   */
  prepareRangedEdit: (
    range: TimelineRange,
    options: RangedEditOptions,
    /** `exact`: 境を寄せない(イン点・アウト点で決めた範囲。Shift+Delete と同じ所を使う) */
    how?: { exact?: boolean }
  ) => Promise<RangedPrepareResult>
  /**
   * 範囲の作り直しの案(標準・詰める・残す)を1つずつ作る(企画には当てない)。作れた案から
   * `onVariant` に今の並びを渡す。中身がほぼ同じ案は1つにまとめる。`signal.aborted` で止める
   */
  prepareRangedVariants: (
    range: TimelineRange,
    options: RangedEditOptions,
    how?: {
      exact?: boolean
      /** この案だけを作る */
      only?: RangedVariantId
      signal?: { aborted: boolean }
      onVariant?: (previews: RangedPreview[]) => void
    }
  ) => Promise<RangedVariantsResult>
  /**
   * 用意した範囲の自動編集を当てる(取り消し1回で戻る)。用意している間に本編が変わっていれば当てない。
   * `variants` は一緒に作った案(当てた後の帯から別の案に替えられる)
   */
  applyRangedEdit: (
    preview: RangedPreview,
    variants?: RangedPreview[]
  ) => { ok: boolean; reason?: string }
  /**
   * 範囲の自動編集の案を替える(当てた案を取り消して別の案を当てるのと同じ。履歴は1件のまま)。
   * 当てた後に別の編集をしていたら替えない。まだ当てていなければ(前を見ている)そのまま当てる
   */
  switchRangedVariant: (preview: RangedPreview) => { ok: boolean; reason?: string }
  /**
   * 案を試しに当てる(「試しに見る」)。履歴には積まない: 試す前の企画・履歴(projectStore の `trial`)と
   * 自動編集の記録(残した場面・範囲の記録・付け直し)を覚え、別の案を試すときは試す前に戻してから当てる
   */
  tryRangedVariant: (
    preview: RangedPreview,
    variants: RangedPreview[]
  ) => { ok: boolean; reason?: string }
  /** 試しに当てた案をやめる(試す前の企画・履歴・記録に丸ごと戻す)。試していなければ何もしない */
  cancelRangedTrial: () => void
  /**
   * この案にする。試していれば、その案を残して履歴を1件だけ積む(違う案を試していたら替えてから)。
   * 試していなければ、ふつうに当てる
   */
  commitRangedVariant: (
    preview: RangedPreview,
    variants: RangedPreview[]
  ) => { ok: boolean; reason?: string }
}

export interface RangeReview {
  beforeClips: Project['clips']
  afterClips: Project['clips']
  /** 当てた後の範囲(タイムラインの秒) */
  range: TimelineRange
  /** 当てる前の範囲 */
  oldRange: TimelineRange
  summary: RangedSummary
  /** 当てた直後の企画(案を替える前に、当てた後に別の編集をしていないかを見る) */
  afterProject: Project
  /** 一緒に作った案と、当てている案 */
  variants: RangedPreview[]
  current: RangedVariantId
}

const initialSteps = (): Record<StepId, StepStatus> => ({
  ingest: { state: 'wait', percent: 0 },
  sync: { state: 'wait', percent: 0 },
  timeline: { state: 'wait', percent: 0 },
  color: { state: 'wait', percent: 0 },
  denoise: { state: 'wait', percent: 0 },
  speakers: { state: 'wait', percent: 0 },
  transcribe: { state: 'wait', percent: 0 },
  events: { state: 'wait', percent: 0 },
  structure: { state: 'wait', percent: 0 },
  cut: { state: 'wait', percent: 0 },
  angles: { state: 'wait', percent: 0 },
  placement: { state: 'wait', percent: 0 },
  effects: { state: 'wait', percent: 0 },
  sound: { state: 'wait', percent: 0 }
})

/** 出演者の名前(マイク1 → 出演者A など)は、同じ収録フォルダの構成なら次の回にも引き継ぐ */
const SOURCE_NAMES_KEY = 've-source-names'
function readSourceNames(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(SOURCE_NAMES_KEY) ?? '{}')
    return v && typeof v === 'object' ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}
function rememberSourceName(id: string, name: string): void {
  try {
    localStorage.setItem(SOURCE_NAMES_KEY, JSON.stringify({ ...readSourceNames(), [id]: name }))
  } catch {
    // 覚えられなくても今回の名前は使える
  }
}

function formatMinutes(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}分${String(s).padStart(2, '0')}秒`
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/**
 * ショートを置く名前(拡張子なし)。同じ名前の企画・動画がすでにあれば「(2)」「(3)」…を付ける。
 * 作り直すと、前に作って手で直したショートの企画と動画を、黙って上書きしていた
 */
export async function freeShortBase(base: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base} (${n})`
    const paths = [`${name}.veproj`, `${name}.mp4`]
    const missing = await window.api.checkFilesExist(paths)
    if (missing.length === paths.length) return name
  }
  return `${base} (${Date.now()})`
}

export const usePipelineStore = create<PipelineState>((set, get) => {
  const log = (text: string): void =>
    set((s) => ({ log: [...s.log, { time: Date.now(), text }].slice(-500) }))
  const setStep = (id: StepId, status: Partial<StepStatus>): void =>
    set((s) => {
      const cur = s.steps[id]
      const next: StepStatus = { ...cur, ...status }
      // 走り始めた時刻を覚え、終わったら(完了・エラー・省略)かかった時間を残す
      if (status.state === 'run' && cur.state !== 'run') {
        next.startedAt = Date.now()
        next.elapsedMs = undefined
      } else if (
        status.state &&
        status.state !== 'run' &&
        cur.state === 'run' &&
        cur.startedAt !== undefined
      ) {
        next.elapsedMs = Date.now() - cur.startedAt
      }
      return { steps: { ...s.steps, [id]: next } }
    })

  /**
   * 話者の判定(ピンマイクの音量)→ 文字起こし。結果は素材の時刻で企画に保存する。
   * ピンマイクが無ければ、基準カメラの音で発話を探し、話者は空のままにする。
   */
  async function transcribeEpisode(
    used: EditableSource[],
    files: SyncInputFile[],
    report: SyncReport,
    assetIdOf: Record<string, string>,
    anchorSourceId: string
  ): Promise<void> {
    setStep('speakers', { state: 'run', percent: 0, note: '音量を読み込み中' })
    // 待つ間に中止した・別の企画を開いたら先へ進まない(進むと、文字起こしの結果とマイクの消音を、
    // 開き直した別の企画へ書き込んでいた)。待った後ごとに確かめる
    const session = useProjectStore.getState().projectSession
    const ensureSameRun = (): void => {
      stopIfCanceled()
      if (useProjectStore.getState().projectSession !== session)
        throw new Error('PIPELINE_CANCELED')
    }
    const mics = used.filter((s) => s.kind === 'mic')
    const speakerSources = mics.length > 0 ? mics : used.filter((s) => s.id === anchorSourceId)
    const placeOf = new Map(report.placements.map((p) => [p.id, p]))
    const targetFiles = files.filter(
      (f) => speakerSources.some((s) => s.id === f.sourceId) && placeOf.get(f.id)?.method !== 'none'
    )
    // ノイズを除いた音声があればそれを読む(時刻は元の録音と同じ。雑音で発話の区切りを誤らない)
    const assetsNow = useProjectStore.getState().project.assets
    const pathOf = (f: SyncInputFile): string =>
      assetsNow.find((a) => a.id === assetIdOf[f.id])?.filePath ?? f.path
    const envelopes = await window.api.footageEnvelopes(targetFiles.map(pathOf))
    ensureSameRun()
    const length = Math.ceil(
      Math.max(
        0,
        ...targetFiles.map((f) => {
          const p = placeOf.get(f.id)!
          return p.start + f.duration / (p.rate || 1)
        })
      ) * TURN_RATE
    )
    const tracks: MicTrack[] = speakerSources.map((s) => {
      const env = new Float32Array(length).fill(NaN)
      targetFiles.forEach((f, i) => {
        if (f.sourceId !== s.id) return
        const p = placeOf.get(f.id)!
        placeEnvelope(envelopes[i], p.start, p.rate || 1, length, env)
      })
      return { id: s.id, envelope: env }
    })
    // OBS から取り出した声のトラックと、同じ人のマイク(Craig のファイルなど)が両方あれば、
    // 取り出したトラックを話者の判定・文字起こしから外し、鳴らさない(発言が2回・声が二重になる)
    // OBS から取り出した声・通話のトラックと、同じ人のマイク(Craig のファイルなど)が両方あれば、
    // 取り出したトラックを話者の判定・文字起こしに使わず、鳴らさない(発言が2回・声が二重になる)。
    // 通話のトラックは、一緒に遊ぶ人みんなの声なので、Craig の何人分かのファイルを合わせたものと比べる
    const duplicates = new Set<string>()
    // 全部入りの残り(配信者の声)を話者にした音源。発言の話者は「配信者」にする(トラックの名前にしない)
    const mixSpeakers = new Set<string>()
    const roleOf = (id: string): string | undefined =>
      speakerSources.find((s) => s.id === id)?.trackRole
    const ownMics = tracks.filter((o) => roleOf(o.id) === undefined)
    for (const t of tracks) {
      const src = speakerSources.find((s) => s.id === t.id)
      if (src?.trackRole !== 'voice' && src?.trackRole !== 'call') continue
      const twin = ownMics.find((o) => sameVoice(t, o))
      // 何人分かを合わせて比べるのは通話のトラックだけ(配信者の声のトラックを、友達のマイクを
      // 合わせたものと比べると、友達がよく話す回で配信者の声まで外してしまう)
      const covered =
        !twin && src.trackRole === 'call' && coveredBy(t, ownMics) >= SAME_VOICE_COVERAGE
      if (!twin && !covered) continue
      duplicates.add(t.id)
      log(
        twin
          ? `「${src.name}」は「${speakerSources.find((s) => s.id === twin.id)?.name ?? ''}」と同じ声のため、話者の判定・文字起こしに使わず、鳴らしません`
          : `「${src.name}」の声は1人ずつのマイク(${ownMics.map((o) => speakerSources.find((s) => s.id === o.id)?.name ?? '').join('・')})に入っているため、話者の判定・文字起こしに使わず、鳴らしません`
      )
      const track = useProjectStore
        .getState()
        .project.audioTracks.find((x) => x.multicamSourceId === t.id && !x.muted)
      if (track) useProjectStore.getState().toggleAudioTrackMute(track.id)
    }
    // 全部入りに、ほかのどのトラック(ゲーム音・声・通話・1人ずつのマイク)にも無い音があれば、
    // 全部入りだけが全員の声の入った録音(名前の無い「声らしい」トラックが、実は通話だった など)。
    // 全部入りだけを鳴らし、ほかは鳴らさない(文字起こしには使う)
    for (const mixSrc of used.filter((s) => s.kind === 'audio' && s.trackRole === 'mix')) {
      const parentPathOf = (x: EditableSource): string | undefined =>
        x.files.find((f) => f.track)?.track?.parentPath
      const group = used.filter(
        (x) => parentPathOf(x) !== undefined && parentPathOf(x) === parentPathOf(mixSrc)
      )
      const gameSrcs = group.filter((s) => s.trackRole === 'game')
      const own = [mixSrc, ...gameSrcs]
      const ownFiles = files.filter(
        (f) => own.some((s) => s.id === f.sourceId) && placeOf.get(f.id)?.method !== 'none'
      )
      if (!ownFiles.some((f) => f.sourceId === mixSrc.id)) continue
      const ownEnv = await window.api.footageEnvelopes(ownFiles.map(pathOf))
      ensureSameRun()
      const placed = (sourceId: string): Float32Array => {
        const env = new Float32Array(length).fill(NaN)
        ownFiles.forEach((f, i) => {
          if (f.sourceId !== sourceId) return
          const p = placeOf.get(f.id)!
          placeEnvelope(ownEnv[i], p.start, p.rate || 1, length, env)
        })
        return env
      }
      if (
        !mixHasUnaccountedSound(placed(mixSrc.id), [
          ...gameSrcs.map((g) => placed(g.id)),
          ...tracks.map((t) => t.envelope)
        ])
      )
        continue
      log(
        `「${mixSrc.name}」に、ほかのトラック・マイクに無い声があるため、「${mixSrc.name}」だけを鳴らします(ほかのトラック・マイクは文字起こしにだけ使います)。「${mixSrc.name}」も話者の判定・文字起こしに使います`
      )
      // その声(多くは配信者の実況)は全部入りにしか無いので、全部入りも話者の判定・文字起こしに使う。
      // 全部入りのままだと、友達の発言・ゲーム音まで全部入りの発言になる(テロップが2回・長くつながる)ので、
      // 同じ録画のほかのトラック(ゲーム音・声・通話)を差し引いた残りで判定する。
      // 別に録ったマイク(Craig など)の人の声は音量が揃わず引けないので、その人が話している所は全部入りを使わない
      const sameRecording = tracks.filter((t) => group.some((g) => g.id === t.id))
      const residual = mixResidual(placed(mixSrc.id), [
        ...gameSrcs.map((g) => placed(g.id)),
        ...sameRecording.map((t) => t.envelope)
      ])
      // 伏せた所(NaN)は「録っていない」ではない。止まったマイクとして扱わせないよう、伏せた時刻を覚える
      // (全部入りを録っていない時刻は、今までどおり止まったマイク)
      const maskedFrames = new Uint8Array(residual.length)
      if (!group.some((g) => g.trackRole === 'call')) {
        const others = tracks.filter((t) => !duplicates.has(t.id) && !sameRecording.includes(t))
        const busy = activityMask(others)
        const pad = Math.round(MIX_MASK_PAD_SEC * TURN_RATE)
        // 声の出だし・終わりの小さい所も含めるよう、前後に少し広げる
        for (let i = 0; i < busy.length; i++) {
          if (!busy[i]) continue
          const a = Math.max(0, i - pad)
          const b = Math.min(residual.length, i + pad + 1)
          for (let k = a; k < b; k++) if (Number.isFinite(residual[k])) maskedFrames[k] = 1
          residual.fill(NaN, a, b)
        }
      }
      tracks.push({ id: mixSrc.id, envelope: residual, maskedFrames })
      mixSpeakers.add(mixSrc.id)
      for (const f of ownFiles) if (f.sourceId === mixSrc.id) targetFiles.push(f)
      speakerSources.push(mixSrc)
      const project = useProjectStore.getState().project
      for (const t of project.audioTracks) {
        if (!t.multicamSourceId) continue
        const src = used.find((s) => s.id === t.multicamSourceId)
        if (!src) continue
        const want =
          src.id === mixSrc.id ? false : group.includes(src) || src.kind === 'mic' ? true : t.muted
        if (t.muted !== want) useProjectStore.getState().toggleAudioTrackMute(t.id)
      }
    }
    // 鳴らす全部入りに、別に録ったマイク(Craig など)の人の声も入っていれば、そのマイクは鳴らさない
    // (文字起こしには使う)。全部入りと Craig の両方が鳴り、友達の声が二重(+6dB)に重なっていた
    for (const mixSrc of used.filter((s) => s.kind === 'audio' && s.trackRole === 'mix')) {
      const audible = useProjectStore
        .getState()
        .project.audioTracks.some((x) => x.multicamSourceId === mixSrc.id && !x.muted)
      if (!audible) continue
      const mixFiles = files.filter(
        (f) => f.sourceId === mixSrc.id && placeOf.get(f.id)?.method !== 'none'
      )
      if (mixFiles.length === 0) continue
      const candidates = ownMics.filter((o) =>
        useProjectStore
          .getState()
          .project.audioTracks.some((x) => x.multicamSourceId === o.id && !x.muted)
      )
      if (candidates.length === 0) continue
      const mixEnvRaw = await window.api.footageEnvelopes(mixFiles.map(pathOf))
      ensureSameRun()
      const mixEnv = new Float32Array(length).fill(NaN)
      mixFiles.forEach((f, i) => {
        const p = placeOf.get(f.id)!
        placeEnvelope(mixEnvRaw[i], p.start, p.rate || 1, length, mixEnv)
      })
      for (const mic of candidates) {
        const others = tracks.filter((t) => t.id !== mic.id && t.id !== mixSrc.id)
        if (!mixCarriesVoice(mixEnv, activityMask([mic]), activityMask(others))) continue
        const name = speakerSources.find((s) => s.id === mic.id)?.name ?? ''
        log(
          `「${mixSrc.name}」に「${name}」の声も入っているため、「${name}」は鳴らしません(文字起こしには使います)`
        )
        const track = useProjectStore
          .getState()
          .project.audioTracks.find((x) => x.multicamSourceId === mic.id && !x.muted)
        if (track) useProjectStore.getState().toggleAudioTrackMute(track.id)
      }
    }
    const turns = detectTurns(tracks.filter((t) => !duplicates.has(t.id)))
    const overlapCount = turns.filter((t) => t.overlap).length
    setStep('speakers', {
      state: 'done',
      percent: 100,
      note:
        mics.length > 1 || speakerSources.length > 1
          ? `発話 ${turns.length} · 重なり ${overlapCount}`
          : mics.length === 1
            ? `発話 ${turns.length} · ${SINGLE_MIC_NOTE}`
            : `発話 ${turns.length} · ピンマイクが無いため話者は未判定`
    })
    // マイク1本(一人で話す・複数の人を1本で録った)では、話者を分けない(仕様)。複数の人が話す回で、
    // 話者が分かれないことが画面から分からなかった(試し編集 第2回)
    if (mics.length === 1 && speakerSources.length === 1)
      log(
        `話者の判定: ${SINGLE_MIC_NOTE}(文字起こし・テロップの話者はすべて「${mics[0].name}」になります)`
      )
    log(
      mics.length > 0
        ? `話者を判定しました: ${mics
            .map((m) => `${m.name} ${turns.filter((t) => t.micId === m.id).length}`)
            .join('、')}(声の重なり ${overlapCount})`
        : '話者の判定: ピンマイクが無いため、基準カメラの音で発話だけを探しました'
    )

    // --- 文字起こし
    const jobs = turnsToJobs(
      turns,
      targetFiles.map((f) => ({
        id: f.id,
        path: pathOf(f),
        sourceId: f.sourceId,
        duration: f.duration
      })),
      report.placements
    )
    setStep('transcribe', { state: 'run', percent: 0, note: `${jobs.length} 件の発話` })
    log(`文字起こしを始めます(${jobs.length} 件)`)
    const t0 = Date.now()
    let asrPercent = 0
    const off = window.api.onAsrProgress((m) => {
      if (m.type === 'status') setStep('transcribe', asrStepProgress(m, asrPercent))
      else if (m.type === 'device') {
        set({ asrDevice: m.device })
        log(
          `音声認識: ${m.device === 'cpu' ? 'CPU' : `GPU(${m.device === 'dml' ? 'DirectML' : 'CUDA'})`}`
        )
        if (m.note) log(m.note)
      } else if (m.type === 'progress') {
        const left =
          m.done > 0 ? (((Date.now() - t0) / m.done) * (m.total - m.done)) / 1000 : undefined
        const next = asrStepProgress(m, asrPercent)
        asrPercent = next.percent
        setStep('transcribe', {
          percent: next.percent,
          note: `${next.note}${left !== undefined ? ` · 残り約 ${Math.ceil(left / 60)} 分` : ''}`
        })
      }
    })
    let results: AsrJobResult[]
    try {
      ensureSameRun()
      results = await window.api.asrRun(jobs.map((j) => j.job))
    } finally {
      off()
    }
    ensureSameRun()
    const byId = new Map(results.map((r) => [r.id, r]))
    const nameOf = new Map(used.map((s) => [s.id, s.name]))
    const utterances: TranscriptUtterance[] = []
    // 音楽・効果音の所の作り話(発話をまたいだ繰り返し・話す速さに合わない文字数)は、同じ素材の発話を
    // 時刻の順に並べて見る(「2分間」「2分間2分間2分間2分間」・「んんんんん…」が 10〜20 秒のテロップになっていた)
    const made = new Set<string>()
    const byFile = new Map<
      string,
      { id: string; text: string; start: number; end: number; words: AsrJobResult['words'] }[]
    >()
    for (const j of jobs) {
      const r = byId.get(j.job.id)
      if (!r) continue
      const list = byFile.get(j.fileId) ?? []
      list.push({ id: j.job.id, text: r.text, start: j.job.start, end: j.job.end, words: r.words })
      byFile.set(j.fileId, list)
    }
    for (const list of byFile.values())
      for (const i of hallucinatedIndices(list)) made.add(list[i].id)
    for (const j of jobs) {
      const r = byId.get(j.job.id)
      if (!r || made.has(j.job.id) || isLikelyHallucination(r.text)) continue
      const assetId = assetIdOf[j.fileId]
      if (!assetId) continue
      utterances.push({
        id: uuid(),
        assetId,
        speaker:
          mics.length === 0 || j.turn.uncertain
            ? undefined
            : mixSpeakers.has(j.turn.micId)
              ? streamerName(nameOf.get(j.turn.micId))
              : nameOf.get(j.turn.micId),
        sourceStart: j.job.start,
        sourceEnd: j.job.end,
        text: r.text,
        words: r.words,
        overlap: j.turn.overlap
      })
    }
    // 数字と単位(「約4」「%弱…」)の間で分かれた発話はつなぐ
    const joined = joinSplitNumbers(utterances)
    useProjectStore.getState().setTranscript(joined)
    setStep('transcribe', {
      state: 'done',
      percent: 100,
      note: `${joined.length} 件 · ${Math.round((Date.now() - t0) / 1000)} 秒`
    })
    log(`文字起こしが終わりました(${joined.length} 件)`)
  }

  /** カメラの色を基準カメラに合わせる。失敗しても編集は続ける(色が揃わないだけ) */
  async function matchColors(): Promise<void> {
    const project = useProjectStore.getState().project
    const info = project.multicam
    const cameras = info?.sources.filter((x) => x.kind === 'camera') ?? []
    if (!info || cameras.length < 2) {
      setStep('color', { state: 'skipped', note: 'カメラが1台です' })
      return
    }
    setStep('color', { state: 'run', percent: 0, note: '同じ時刻の画を読み込み中' })
    try {
      const plan = await planCameraColors(info, project.assets, (done, total) =>
        setStep('color', { percent: (done / total) * 100, note: `${done}/${total} 枚の画` })
      )
      useProjectStore.getState().setColorMatches(plan.matches)
      set({
        colorIssues: plan.cameras
          .filter((c) => c.verdict === 'flat' || c.verdict === 'shape' || c.verdict === 'few')
          .map((c) => ({
            name: c.name,
            verdict: c.verdict as Exclude<ColorMatchVerdict, 'matched' | 'same'>
          }))
      })
      const fixed = plan.cameras.filter((c) => c.match)
      const unmatched = get().colorIssues.length
      setStep('color', {
        state: 'done',
        percent: 100,
        note:
          [
            fixed.length > 0 ? `${fixed.length} 台を基準カメラに合わせました` : '',
            unmatched > 0 ? `合わせられないカメラ ${unmatched} 台(要確認)` : ''
          ]
            .filter(Boolean)
            .join(' · ') || '合わせる必要のあるカメラはありませんでした'
      })
      for (const c of plan.cameras)
        log(
          c.match
            ? `色合わせ: ${c.name} を基準カメラに合わせました(${describeColorMatch(c.match)})`
            : `色合わせ: ${c.name} は${COLOR_VERDICT_TEXT[c.verdict === 'matched' ? 'same' : c.verdict]}`
        )
    } catch (e) {
      setStep('color', { state: 'error', note: formatIpcError(e) })
      log(`カメラの色合わせができませんでした(色は元のまま): ${formatIpcError(e)}`)
    }
  }

  /** ピンマイクの音声からノイズを除く。失敗しても編集は続ける(元の録音のまま) */
  async function denoiseMics(): Promise<void> {
    const project = useProjectStore.getState().project
    const info = project.multicam
    const micIds = new Set(info?.sources.filter((x) => x.kind === 'mic').map((x) => x.id))
    const assets = project.assets.filter((a) =>
      info?.files.some((f) => f.assetId === a.id && micIds.has(f.sourceId))
    )
    if (assets.length === 0) {
      setStep('denoise', { state: 'skipped', note: 'ピンマイクがありません' })
      return
    }
    setStep('denoise', { state: 'run', percent: 0, note: '準備中' })
    const off = window.api.onDenoiseProgress((p) =>
      setStep('denoise', { percent: p.percent, note: `${p.done}/${p.total} 本` })
    )
    try {
      const sources = assets.map((a) => a.denoisedFrom ?? a.filePath)
      const results = await window.api.denoiseRun(sources)
      const changes: Record<string, string | null> = {}
      set({
        denoiseFailures: results
          .map((r, i) => ({ r, a: assets[i] }))
          .filter((x) => !x.r.cleaned)
          .map((x) => ({ assetId: x.a.id, fileName: x.a.fileName, error: x.r.error ?? '' }))
      })
      results.forEach((r, i) => {
        if (r.cleaned) changes[assets[i].id] = r.cleaned
        else
          log(
            `ノイズ除去: ${assets[i].fileName} はできませんでした(元の録音のまま): ${r.error ?? ''}`
          )
      })
      applyWhenNotTrying(() =>
        useProjectStore.getState().setAssetsDenoised(changes, {
          expectFilePath: Object.fromEntries(assets.map((a) => [a.id, a.filePath]))
        })
      )
      if (runCanceled) {
        setStep('denoise', { state: 'wait', note: '中止しました' })
        return
      }
      const done = Object.keys(changes).length
      setStep('denoise', {
        state: done > 0 ? 'done' : 'error',
        percent: 100,
        note: `${done}/${assets.length} 本`
      })
      log(`ピンマイクのノイズ除去: ${done} 本(素材一覧の右クリックで外せます)`)
    } catch (e) {
      const msg = formatIpcError(e)
      // 中止したときは失敗ではない(工程の一覧に失敗の印を残さない。この後の工程へは進まない)
      if (isCanceled(msg)) {
        setStep('denoise', { state: 'wait', note: '中止しました' })
        return
      }
      setStep('denoise', { state: 'error', note: msg })
      log(`ピンマイクのノイズ除去ができませんでした(元の録音のまま): ${msg}`)
    } finally {
      off()
    }
  }

  /** 番組素材フォルダから SE・BGM を選んで置く(仮編集を入れた後) */
  async function placeSounds(
    keptIds: string[],
    spans: { timeline: number; start: number; end: number }[],
    effectTelops: Omit<TextOverlay, 'id'>[],
    allTelops: Omit<TextOverlay, 'id'>[],
    /** 自動編集で触らない範囲: その所は前の自動の SE・BGM・CG を残す(無ければ今までと同じ) */
    locked?: LockedSounds
  ): Promise<void> {
    const folder = useSettingsStore.getState().showKitFolder
    if (!folder) {
      setStep('sound', { state: 'skipped', note: '番組素材フォルダが未設定です' })
      return
    }
    setStep('sound', { state: 'run', percent: 0, note: '番組素材フォルダを読み込み中' })
    // 仮編集を入れた直後の本編(置くときに、これから直されていないかを見る)
    const afterCut = useProjectStore.getState().project.clips
    try {
      const kit = await window.api.showKitScan(folder)
      // 曲の雰囲気の決めかねは、場面を選ぶのに使った判定(見どころを置き換えた後)の印で
      const judged = new Map((get().planJudgements ?? get().judgements).map((j) => [j.sceneId, j]))
      const scenes = get()
        .scenes.filter((sc) => keptIds.includes(sc.id))
        .map((sc) => {
          const range = timelineRangeOf(spans, sc.start, sc.end)
          const j = judged.get(sc.id)
          return range ? { ...range, mood: j?.mood ?? fallbackMood(j?.kind ?? 'normal') } : null
        })
        .filter((x): x is { start: number; end: number; mood: BgmMood } => x !== null)
      const kindOf = new Map(get().effects.map((e) => [e.id, e.kind]))
      const effects = effectTelops
        .filter((t) => t.effectId && kindOf.has(t.effectId))
        .map((t) => ({ time: t.startTime, kind: kindOf.get(t.effectId!)!, text: t.text }))
      const style = useSettingsStore.getState().showStyle?.style
      const duration = spans.reduce((t, x) => Math.max(t, x.timeline + (x.end - x.start)), 0)
      let se = planSoundEffects(
        // 本編の終わりより後(人が演出テロップを動かした など)に SE は置かない
        effects.filter((e) => e.time < duration),
        scenes.map((x) => x.start),
        kit,
        style ? { perMinute: style.sePerMinute, durationSec: duration } : undefined
      )
      let bgm = planBgm(scenes, kit, style?.bgmVolume)
      let cg = planCg(allTelops, kit.cg)
      if (locked) {
        se = keepLockedSounds(se, locked, 'se')
        bgm = keepLockedSounds(bgm, locked, 'bgm')
        cg = keepLockedCg(cg, locked)
      }
      // 置く素材を読み込む(すでにあるものは使い回す)
      const assets = await loadKitAssets([...se, ...bgm, ...cg].map((x) => x.path))
      // 用意している間に本編が直されたなら置かない(置く時刻は、仮編集を入れたときの本編で決めてある)
      if (useProjectStore.getState().project.clips !== afterCut) {
        setStep('sound', {
          state: 'error',
          note: '用意している間に本編が直されたため、置きませんでした。もう一度作り直してください'
        })
        log(
          'SE・BGM・CG を用意している間に本編が直されたため、置きませんでした(直したものはそのままです)'
        )
        return
      }
      useProjectStore.getState().setAutoSounds(
        [
          { role: 'se', clips: se },
          { role: 'bgm', clips: bgm }
        ],
        assets,
        afterCut
      )
      useProjectStore.getState().setAutoCg(cg, assets, afterCut)
      // 手で直した自動のトラックは残し、その種類は置き直していない。本編を作り直していれば時刻がずれうるので知らせる
      {
        const p = useProjectStore.getState().project
        const edited = [
          ...p.audioTracks.filter((t) => t.autoRole && t.autoSignature === undefined),
          ...p.videoOverlayTracks.filter((t) => t.autoRole && t.autoSignature === undefined)
        ].map((t) => t.name)
        if (edited.length > 0)
          log(
            `手で直した ${edited.join('・')} はそのまま残し、置き直していません(本編を作り直した後は、時刻が合っているか確かめてください。置き直すにはトラックを消してから作り直します)`
          )
      }
      // 足した素材(ProRes の CG など)が画面で再生できない形式なら、素材一覧の側でプレビュー用に変換する
      if (assets.length > 0) emitMenuCommand('assets.checkPreview')
      const seCats = Object.keys(kit.se).length
      const bgmMoods = Object.keys(kit.bgm).length
      setStep('sound', {
        state: 'done',
        percent: 100,
        note: `SE ${se.length} · BGM ${bgm.length} 本 · CG ${cg.length}`
      })
      log(
        `SE・BGM・CG: SE ${se.length} 個(分類 ${seCats})、BGM ${bgm.length} 本(雰囲気 ${bgmMoods})、CG ${cg.length} 個(きっかけの言葉 ${Object.keys(kit.cg).length})を置きました${
          seCats + bgmMoods + Object.keys(kit.cg).length === 0
            ? '。番組素材フォルダに SE / BGM / CG のフォルダが見つかりません'
            : ''
        }`
      )
    } catch (e) {
      setStep('sound', { state: 'error', note: formatIpcError(e) })
      log(`SE・BGM を置けませんでした: ${formatIpcError(e)}`)
    }
  }

  /** 笑い・歓声を、基準カメラの音から探す。失敗しても編集は続ける(構成の判定に使わないだけ) */
  async function detectEvents(): Promise<void> {
    const project = useProjectStore.getState().project
    const info = project.multicam
    const files = (info?.files ?? [])
      .filter((f) => f.sourceId === info?.anchorSourceId)
      .map((f) => ({
        path: project.assets.find((a) => a.id === f.assetId)?.filePath ?? '',
        start: f.start,
        rate: f.rate,
        duration: f.duration
      }))
      .filter((f) => f.path)
    if (files.length === 0) {
      setStep('events', { state: 'skipped', note: '基準カメラの音がありません' })
      return
    }
    setStep('events', { state: 'run', percent: 0, note: '準備中' })
    const off = window.api.onEventsProgress((m) => {
      if (m.type === 'status') setStep('events', { note: m.note })
      else if (m.type === 'device')
        log(
          `笑い・歓声の検出: ${m.device === 'cpu' ? 'CPU' : `GPU(${m.device === 'dml' ? 'DirectML' : 'CUDA'})`}`
        )
      else if (m.type === 'progress' && m.total)
        setStep('events', {
          percent: ((m.done ?? 0) / m.total) * 100,
          note: `${Math.round((m.done ?? 0) / 60)}/${Math.round(m.total / 60)} 分`
        })
    })
    try {
      const events = await window.api.eventsRun(files)
      useProjectStore.getState().setAudioEvents(events)
      const all = countEvents(events, -Infinity, Infinity)
      setStep('events', {
        state: 'done',
        percent: 100,
        note: `笑い ${all.laughs} · 歓声 ${all.cheers}`
      })
      log(
        `笑い・歓声の検出: 笑い ${all.laughs} 回、歓声・拍手 ${all.cheers} 回(構成の判定に使います)`
      )
    } catch (e) {
      const msg = formatIpcError(e)
      setStep('events', {
        state: msg.includes('EVENTS_CANCELED') ? 'wait' : 'error',
        note: msg.includes('EVENTS_CANCELED') ? '中止しました' : msg
      })
      if (!msg.includes('EVENTS_CANCELED'))
        log(`笑い・歓声の検出ができませんでした(構成は発言だけで判定します): ${msg}`)
    } finally {
      off()
    }
  }

  let activityCache: { projectId: string; mask: Uint8Array } | null = null
  async function activityOf(project: Project, info: MulticamInfo): Promise<Uint8Array> {
    if (activityCache?.projectId !== project.id) {
      activityCache = { projectId: project.id, mask: await loadActivity(project, info) }
    }
    return activityCache.mask
  }

  /**
   * 自動編集の判断(場面の判定・残す/落とす・仕上がりの長さ・方針・演出テロップの提案と採否・同期の要約)を
   * 企画に覚える。保存して開き直したときに、そのまま戻す(覚えていないと、開き直して作り直すと
   * 手で残した場面・AI の判定で残した場面が落ち、演出テロップも消えていた)
   */
  /**
   * 今の組んだ本編(`roughCutAuto` の印)で残している場面。前の回の記録から読む(今の本編から推し量らない)
   */
  function keptScenesOf(base: Project): string[] {
    const sig = cutSignature(base.roughCutAuto)
    return (
      (sig ? [...get().builtKept].reverse().find((b) => b.cut === sig)?.keptIds : undefined) ??
      get().roughCut?.keptIds ??
      []
    )
  }

  function persistDecisions(): void {
    const s = get()
    const project = useProjectStore.getState().project
    if (!project.multicam || s.scenes.length === 0 || !s.judgeSource) return
    const sync = s.report ? syncSummaryOf(s.report, project) : project.autoEdit?.sync
    const decisions: AutoEditDecisions = {
      kind: s.sceneKind ?? useSettingsStore.getState().episodeKind,
      ...(s.hype.length > 0 ? { hype: s.hype } : {}),
      scenes: s.scenes.map((sc) => ({ id: sc.id, start: sc.start, end: sc.end })),
      judgements: s.judgements,
      ...(s.planJudgements ? { planJudgements: s.planJudgements } : {}),
      judgeSource: s.judgeSource,
      keep: s.keep,
      targetMinutes: s.targetMinutes,
      editNote: s.editNote,
      ...(s.roughCut ? { keptIds: s.roughCut.keptIds } : {}),
      ...(s.builtKept.length > 0 ? { builtKept: s.builtKept } : {}),
      ...(s.keepTouched.length > 0 ? { keepTouched: s.keepTouched } : {}),
      ...(s.restored?.legacy ? { legacyPending: true } : {}),
      effects: s.effects,
      effectChosen: s.effectChosen,
      ...(s.steps.effects.state === 'done' ? { effectsAsked: true } : {}),
      ...(s.steps.effects.state === 'skipped'
        ? { effectsSkipped: s.steps.effects.note ?? '' }
        : {}),
      ...(s.carriedTelops.length > 0 ? { carriedTelops: s.carriedTelops } : {}),
      ...(sync ? { sync } : {}),
      // 色合わせが済んだこと(合わせる必要が無かった回は素材に印が残らないため。開き直して「済み」と出す)
      ...(s.steps.color.state === 'done' ? { colorDone: s.steps.color.note ?? '' } : {}),
      // SE・BGM・CG の工程が済んだ・省いたこと(置く物が無ければ自動のトラックが残らないため)
      ...(s.steps.sound.state === 'done' || s.steps.sound.state === 'skipped'
        ? { soundDone: { state: s.steps.sound.state, note: s.steps.sound.note ?? '' } }
        : {}),
      ...(s.rangeRuns.length > 0 ? { rangeRuns: s.rangeRuns } : {})
    }
    useProjectStore.getState().setAutoEdit(decisions)
  }

  /** 構成(場面の判定)→ カット → アングル → 仮編集を入れる */
  async function structureAndCut(): Promise<void> {
    const project = useProjectStore.getState().project
    const info = project.multicam
    if (!info || !(project.transcript?.length ?? 0)) {
      for (const id of ['structure', 'cut', 'angles', 'placement', 'effects', 'sound'] as StepId[])
        setStep(id, { state: 'skipped', note: '文字起こしがありません' })
      return
    }
    setStep('structure', { state: 'run', percent: 0, note: '場面に分けています' })
    const kind = useSettingsStore.getState().episodeKind
    // ゲーム実況は、声の盛り上がり(叫び・大声)を面白い所の印にする
    let hype: HypeMoment[] | undefined
    if (kind === 'game') {
      hype = hypeMomentsFor(project, info, await activityOf(project, info))
      log(`声の盛り上がり(叫び・大声): ${hype.length} 回`)
    }
    const scenes = scenesFor(project, info, { kind, hype })
    const range = cameraRange(info)
    const { geminiApiKey: apiKey, aiProvider: provider } = useSettingsStore.getState()
    const { judgements, source, failure, model, device } = await judgeScenes(
      scenes,
      range.end - range.start,
      {
        provider,
        apiKey,
        episodeName: project.name,
        targetSec: get().targetMinutes * 60 || (kind === 'game' ? 0 : range.end - range.start),
        note: get().editNote || undefined,
        kind
      },
      (p) => setStep('structure', { percent: p.percent, note: p.note })
    )
    // 判定の間に中止・別の回を開いたなら、結果を書かない
    stopIfCanceled()
    set({
      scenes,
      judgements,
      planJudgements: null,
      judgeSource: source,
      keep: {},
      builtKept: [],
      keepTouched: [],
      rangeRuns: [],
      hype: hype ?? [],
      sceneKind: kind
    })
    forgetUsedTouches()
    setStep('structure', {
      state: 'done',
      percent: 100,
      note: structureNote(judgements, source, false)
    })
    persistDecisions()
    log(
      source === 'ai'
        ? `構成: AI(${model ?? ''}${device ? `・${device === 'cpu' ? 'CPU' : `GPU ${device.toUpperCase()}`}` : ''})で ${scenes.length} 場面を判定しました`
        : failure
          ? `構成: AI に頼めなかったため簡易の点数で判定しました(${failure})`
          : '構成: AI を使わない設定のため、簡易の点数(発話の密度・掛け合い・盛り上がり)で判定しました'
    )
    await buildAndApply()
  }

  /**
   * 本編の修正より優先する「残す / 落とす」(その場面の中の手の削りを取り消す)。「落とす」は全部。
   * 「残す」は、前回の作り直しで落としていた場面を今回残すに変えたものだけ(既に残っている場面の中を
   * その後で手で詰めた所は、作り直すたびに戻さない)。前回の残す/落とすは、今の組んだ本編
   * (`roughCutAuto`。取り消しで本編と一緒に戻る)と同じ印の回のもの(`builtKept`)。今の本編から
   * 残した場面を推し量らない(場面の入れ替え・一部だけ残す・差し込みで読み違えた)。
   * 同じ印の回が分からない(覚えている回より前まで取り消した など)ときは、手で残すにした場面を全部
   * (10/09 版と同じ。昔の削りも戻る)。「残す」の場面に今の本編のクリップが1本も無い(人が丸ごと
   * 消した)ときは、その場面のチェックを付け直したときだけ渡す(作り直すと戻す。10/09 版と同じ)。
   * 付け直したのは、まだ作り直しで使っていない `keepTouched` と、使った作り直しを取り消して、その
   * 作り直しの前の本編に戻ったときのもの(`usedTouches`)。付け直さなければ、丸ごと
   * 消したのも手の削りとして守る。クリップがどの場面のものかは、いちばん長く重なる場面
   * (`sceneOfSpan`。場面の最後のクリップは次の場面へはみ出す)。取り消す区間は `releaseRanges`
   */
  function releasedKeep(project: Project): {
    keep: Record<string, boolean>
    scenes: { id: string; start: number; end: number }[]
    /** 使った付け直し(この作り直しの回に覚える) */
    touched: string[]
    /** 使った付け直しを読んだ時(この後に触ったものは、作り直しの後も残す) */
    readAt: number
  } {
    const readAt = keepTouchClock
    const scenes = get().scenes
    const auto = project.roughCutAuto ?? []
    const sig = cutSignature(project.roughCutAuto)
    const built = sig ? [...get().builtKept].reverse().find((b) => b.cut === sig) : undefined
    // 付け直した場面(使った作り直しを取り消すと、ここへ戻る。`usedTouches`)
    const touched = new Set(get().keepTouched)
    if (!built)
      return {
        keep: get().keep,
        scenes: releaseRanges(scenes, auto),
        touched: [...touched],
        readAt
      }
    const kept = new Set(built.keptIds)
    const owned = ownedScenes(project, scenes)
    const emptied = (id: string): boolean => touched.has(id) && !owned.has(id)
    return {
      keep: Object.fromEntries(
        Object.entries(get().keep).filter(([id, keep]) => !keep || !kept.has(id) || emptied(id))
      ),
      scenes: releaseRanges(scenes, auto),
      touched: [...touched],
      readAt
    }
  }

  async function buildAndApply(): Promise<void> {
    const project = useProjectStore.getState().project
    const info = project.multicam
    if (!info) return
    setStep('cut', { state: 'run', percent: 0, note: '音の大きさを読み込み中' })
    const activity = await activityOf(project, info)
    // 前に組んだ本編と今の本編を比べ、人が削った・足した区間、替えたカメラを読み取る
    const released = releasedKeep(project)
    // 自動編集で触らない範囲(ロック)。ロックの中は場面の残す/落とすで手の削りを取り消さず、
    // 今の中身に固定する(ロックが無ければ今までと同じ)
    const locks = (project.autoEditLocks ?? []).map((l) => ({ start: l.start, end: l.end }))
    const keptOverrides = releaseOverridesForScenes(
      project.roughCutAuto
        ? updateOverrides(
            project.cutOverrides,
            project.roughCutAuto,
            coverageOfClips(project.clips, info)
          )
        : project.cutOverrides,
      locks.length > 0
        ? released.scenes.flatMap((sc) =>
            subtractRanges([sc], locks).map((r) => ({ id: sc.id, start: r.start, end: r.end }))
          )
        : released.scenes,
      released.keep
    )
    const overrides =
      locks.length > 0
        ? overridesWithPinned(
            keptOverrides,
            // 同じ時刻を2回映す本編(複製・並べ替え)は、組んだ本編と違うカメラ(人が決めた方)を残す
            pinOverrides(locks, coverageOfClips(project.clips, info), project.roughCutAuto),
            locks
          )
        : keptOverrides
    const plan = planRoughCut(project, info, get().scenes, get().judgements, activity, {
      overrides,
      ...(locks.length > 0 ? { locks } : {}),
      targetSec: get().targetMinutes * 60,
      keep: get().keep,
      styles: usePresetStore.getState().captionPresets,
      speechLook: speechLook(
        useSettingsStore.getState().speechTelopLook,
        usePresetStore.getState().captionPresets
      ),
      dictionary: parseDictionary(useSettingsStore.getState().telopDictionary),
      style: useSettingsStore.getState().showStyle?.style,
      kind: useSettingsStore.getState().episodeKind,
      policy: useSettingsStore.getState().editPolicy,
      peaks: peakSpans(get().hype, project.audioEvents)
    })
    // 作っている間(音の読み込み・AI の提案を待つ間など)に編集画面で本編を直したなら当てない。
    // 当てると直したものが作り直しで消え、直したことも次の作り直しに伝わらなかった(取り消しでしか
    // 戻せなかった)
    const editedMeanwhile = (): boolean => {
      if (useProjectStore.getState().project.clips === project.clips) return false
      setStep('cut', {
        state: 'error',
        note: '作っている間に本編が直されたため、当てませんでした。もう一度作り直してください'
      })
      log(
        '作っている間に編集画面で本編が直されたため、仮編集を当てませんでした(直したものはそのままです)'
      )
      return true
    }
    if (editedMeanwhile()) return
    // 残す区間が無い仮編集は当てない(当てると、並べた本編が丸ごと消える)
    if (plan.cut.main.length === 0) {
      // 判定が全部を「不要」にしたときは上位を仮に残す(`selectScenes` の `rescued`)ので、ここへ来るのは
      // 人が残す場面を全部外したとき・残した場面に使える区間が無いとき
      const allDroppedByHand =
        get().scenes.length > 0 && get().scenes.every((sc) => get().keep[sc.id] === false)
      setStep('cut', {
        state: 'error',
        note: allDroppedByHand
          ? '残す場面がありません(構成ですべての場面を外しています。残す場面にチェックを付けてください)'
          : '残す場面がありません(構成で残す場面を選ぶか、「大事にすること」を替えてください)'
      })
      log('残す場面が無いため、仮編集を作りませんでした(タイムラインはそのままです)')
      // 作り直しでは、前に済んだ工程(AI に頼んだ演出テロップの提案など)をそのまま残す。
      // 「省略」にすると、次の作り直しで AI に頼み直し、人が外した提案まで置き直してしまう
      for (const id of ['angles', 'placement', 'effects', 'sound'] as StepId[])
        if (get().steps[id].state !== 'done')
          setStep(id, { state: 'skipped', note: '仮編集がありません' })
      return
    }
    set({ planJudgements: plan.demoted ? plan.judgements : null })
    // 工程の欄の見どころの数は、場面を選ぶのに使った判定で(置き換えなかった作り直しでは元に戻す)
    setStep('structure', {
      note: structureNote(plan.judgements, get().judgeSource, Boolean(plan.demoted))
    })
    if (plan.demoted)
      log(
        `構成: ${plan.demoted.total} 場面中 ${plan.demoted.highlights} 場面が「見どころ」で見分けになっていないため、見どころは声の盛り上がり・笑い・発話の密度の点数で選び直しました(題・理由・不要の印はそのまま)`
      )
    if (plan.selection.rescued)
      log(
        `構成: 判定が全 ${plan.selection.rescued.total} 場面を「不要」にしたため、点数・発話の多い ${plan.selection.rescued.kept} 場面を仮に残しました(要確認。「構成」タブで残す場面を確かめてください)`
      )
    if (plan.selection.relaxed)
      log('声の山・笑いのはっきりした場面が無かったため、点数の上位の場面を残しました(静かな回)')
    {
      // 判定が場面を区別できていない(全部に同じ点数)なら、長さで落とした場面は中身の手掛かりで選んだ
      const same = indistinctJudgements(plan.judgements)
      const byLength = plan.selection.dropped.filter((d) => d.why === 'length').length
      if (same)
        log(
          `構成: 判定が ${same.total} 場面すべてに同じ点(${same.score} 点)を付け、場面を区別できていません(要確認)${byLength > 0 ? `。長さに合わせて落とした ${byLength} 場面は、発話の密度・話者の数・数字や固有名詞の多さで選びました` : ''}`
        )
    }
    const raw = plan.selection.kept.reduce((t, id) => {
      const sc = get().scenes.find((x) => x.id === id)
      return t + (sc ? sc.end - sc.start : 0)
    }, 0)
    setStep('cut', {
      state: 'done',
      percent: 100,
      note:
        `${plan.pieces.length} 区間 · 間を詰めて ${formatMinutes(raw)} → ${formatMinutes(plan.cut.duration)}` +
        (plan.selection.rescued
          ? ` · 全場面が「不要」の判定のため ${plan.selection.rescued.kept} 場面を仮に残しました(要確認)`
          : '')
    })
    const switches = plan.shots.length
    setStep('angles', { state: 'done', percent: 100, note: `ショット ${switches}` })

    // 発言テロップを、顔を隠さない位置へ
    setStep('placement', { state: 'run', percent: 0, note: '顔を探しています' })
    let telops = plan.telops
    // ゲーム実況: 画面の動かない表示(体力・スコア・ミニマップ)に発言テロップを重ねない
    if (useSettingsStore.getState().episodeKind === 'game') {
      setStep('placement', { note: 'ゲーム画面の表示を探しています' })
      try {
        const hud = await placeTelopsAvoidingHud(
          telops,
          plan.cut,
          project.assets,
          project.aspectRatio
        )
        telops = hud.telops
        if (hud.y !== null)
          log(
            `ゲーム画面の表示(HUD)が下の中央にあるため、発言テロップ ${hud.moved} 枚を上へ(画面の ${Math.round(hud.y * 100)}% の高さ)`
          )
      } catch (e) {
        log(`ゲーム画面の表示を調べられませんでした(下のまま置きます): ${formatIpcError(e)}`)
      }
    }
    try {
      const placed = await placeTelopsAvoidingFaces(
        telops,
        plan.cut,
        project.assets,
        project.aspectRatio,
        (done, total) =>
          setStep('placement', { percent: (done / total) * 100, note: `${done}/${total} 枚の画` })
      )
      telops = placed.telops
      set({ telopReviews: placed.review })
      setStep('placement', {
        state: 'done',
        percent: 100,
        note: `発言テロップ ${telops.length} · 上へ移した ${placed.moved} · 要確認 ${placed.review.length}${placed.unchecked ? ` · 調べられない ${placed.unchecked}` : ''}`
      })
      log(
        `発言テロップの配置: 顔に掛かるため上へ移した ${placed.moved} 枚、上下とも顔に掛かる ${placed.review.length} 枚`
      )
    } catch (e) {
      // 前の作り直しの要確認を残すと、今の配置と食い違う(もう無いテロップを指す)
      set({ telopReviews: [] })
      setStep('placement', { state: 'error', note: formatIpcError(e) })
      log(`顔の検出ができませんでした(テロップは下のまま): ${formatIpcError(e)}`)
    }
    // 演出テロップ。AI を使わずに決まるもの(人物紹介・笑い・章・時刻・吹き出し)は、残した場面が
    // 変わるので作り直しのたびに作り直す。AI の提案は最初の1回だけ頼み、作り直しでは同じものを置き直す。
    // 人物紹介だけが入っているときは、まだ AI に頼んでいない(AI の設定を入れてから作り直せば頼む)
    let freshAi = false
    {
      const aiAsked = get().steps.effects.state === 'done'
      const { geminiApiKey: apiKey, aiProvider: provider } = useSettingsStore.getState()
      const lines = effectLines(project, info, plan.cut.spans)
      const nameList = nameProposals(lines)
      if (nameList.length > 0)
        log(`人物紹介: ${nameList.map((n) => n.text).join('・')} の最初の発言に名前を出します`)
      const chapters = chapterProposals(get().scenes, plan.judgements, plan.selection.kept)
      const firstKept = get()
        .scenes.filter((sc) => plan.selection.kept.includes(sc.id))
        .sort((a, b) => a.start - b.start)[0]
      const clockTimes = chapters.length
        ? chapters.map((c) => c.at!)
        : firstKept
          ? [firstKept.start]
          : []
      // 笑いの間隔は、仮編集に残った笑いどうしで数える(削った場面の笑いで、残した笑いを消さない)
      const keptEvents = (project.audioEvents ?? []).filter(
        (e) => roughTimelineAt(plan.cut.spans, (e.start + e.end) / 2) !== null
      )
      // 吹き出しの文字は、辞書で直した発言テロップの文字にする(生の文字起こしにしない)
      const speechText = new Map<string, string>()
      for (const o of telops)
        if (o.utteranceId)
          speechText.set(
            o.utteranceId,
            `${speechText.get(o.utteranceId) ?? ''}${o.text.replace(/\n/g, '')}`
          )
      const autos = [
        ...nameList,
        ...laughProposals(keptEvents),
        ...chapters,
        ...clockProposals(clockTimes, info, recordedAtByAsset(project, get().syncedFiles)),
        ...bubbleProposals(lines).map((b) => ({
          ...b,
          text: speechText.get(b.afterLineId) ?? b.text
        }))
      ]
      const autoCount = (kind: string): number => autos.filter((n) => n.kind === kind).length
      if (autos.length > nameList.length)
        log(
          `自動の演出テロップ: 笑い ${autoCount('laugh')}・章 ${autoCount('chapter')}・時刻 ${autoCount('clock')}・吹き出し ${autoCount('bubble')}(時刻・吹き出し・小さい笑いは提案だけ。演出テロップのタブで選べます)`
        )
      // 前にもあった提案は、人が選んだ・外した状態を保つ。新しい提案は自信の高いものだけ置く
      const prevIds = new Set(get().effects.map((e) => e.id))
      const prevChosen = new Set(get().effectChosen)
      // 古い形式の企画では提案の一覧が無く、置いていた演出テロップの ID だけが選んだものに入っている。
      // 同じ提案がまた出たら置いたままにする
      const chooseFrom = (list: readonly EffectProposal[]): string[] =>
        list
          .filter((p) =>
            prevChosen.has(p.id)
              ? true
              : prevIds.has(p.id)
                ? false
                : p.confidence >= AUTO_PLACE_CONFIDENCE
          )
          .map((p) => p.id)
      const aiKinds = new Set<string>(AI_EFFECT_KINDS)
      const keepAi = get().effects.filter((e) => aiKinds.has(e.kind))
      const apply = (ai: readonly EffectProposal[]): number => {
        const proposals = [...autos, ...ai]
        const chosen = chooseFrom(proposals)
        set({ effects: proposals, effectChosen: chosen })
        return chosen.length
      }
      if (aiAsked) {
        apply(keepAi)
      } else if (provider === 'off' || (provider === 'gemini' && !apiKey)) {
        apply([])
        setStep('effects', {
          // 'done' にすると、あとで AI を使える設定にしても二度と頼まない
          state: 'skipped',
          note:
            (provider === 'off'
              ? 'AI を使わない設定です'
              : 'Gemini の鍵がありません(このPCの AI に切り替えると提案します)') +
            (autos.length > 0 ? ` · AI を使わない提案 ${autos.length}` : '')
        })
      } else {
        setStep('effects', { state: 'run', percent: 30, note: 'AI が提案中' })
        try {
          const {
            proposals: aiProposals,
            failed,
            total
          } = await proposeEffects(
            lines,
            {
              provider,
              apiKey,
              episodeName: project.name,
              note: get().editNote || undefined
            },
            (p) => setStep('effects', { percent: p.percent, note: p.note })
          )
          const placed = apply(aiProposals)
          freshAi = aiProposals.length > 0
          const count = autos.length + aiProposals.length
          const failNote = failed > 0 ? ` · AI が答えられなかった ${failed}/${total}` : ''
          setStep('effects', {
            state: 'done',
            percent: 100,
            note: `提案 ${count} · 自動で置いた ${placed}${failNote}`
          })
          log(`演出テロップ: 提案 ${count} 件(自信の高い ${placed} 件を置きました)`)
          if (failed > 0)
            log(
              `演出テロップ: AI が答えを返せなかった区切りがあります(${failed}/${total})。` +
                'このPCの AI が小さいモデルのときに起きやすく、GPU で大きいモデルを使うと減ります'
            )
        } catch (e) {
          if (runCanceled) throw e
          // AI が失敗しても、AI の要らない提案は付ける
          apply([])
          setStep('effects', { state: 'error', note: formatIpcError(e) })
          log(`演出テロップの提案ができませんでした: ${formatIpcError(e)}`)
        }
      }
    }
    if (editedMeanwhile()) return
    const effectTelops = effectOverlays(
      get().effects,
      new Set(get().effectChosen),
      project,
      info,
      plan.cut.spans,
      usePresetStore.getState().captionPresets
    )
    // 吹き出しにした発言は、発言テロップを出さない(同じ言葉が2か所に出る)
    const bubbled = bubbledUtterances(
      get().effects,
      get().effectChosen,
      useProjectStore.getState().project.dismissedTelops
    )
    // 今置いてある演出テロップのうち、今回の提案の一覧に無いものを、新しい仮編集の位置へ写して置き直す。
    // 人が直したものは必ず(AI の提案は頼み直すと ID が変わり、直した文字が引き継がれなかった)。
    // 直していない AI の提案は、新しい AI の提案が無いとき(AI を使わない・失敗した・古い企画で
    // 提案の一覧が無い)だけ。自動で決まる種類(笑い・章・時刻・吹き出し・人物紹介)は毎回作り直すので写さない
    const { placed: carried, remember } = carriedEffectTelops(
      useProjectStore.getState().project,
      get().effects,
      freshAi,
      plan.cut.spans,
      get().carriedTelops
    )
    if (carried.length > 0)
      log(
        `演出テロップ: 今の提案に無い ${carried.length} 枚(人が直したもの・前の提案)を置き直しました`
      )
    set({ lastSpans: plan.cut.spans, speechTelops: telops, carriedTelops: remember })
    // この作り直しで使う付け直しは、取り消しで戻したものでも、ここからはこの作り直しの記録になる
    for (const id of released.touched) revivedFrom.delete(id)
    useProjectStore.getState().applyRoughCut(
      plan.cut,
      [
        ...telops.filter((o) => !o.utteranceId || !bubbled.has(o.utteranceId)),
        ...effectTelops,
        ...carried
      ],
      overrides,
      locks.length > 0
        ? {
            windows: locks,
            // ロックの中は、覚えている手直しも作り直す前のまま(組んだ本編の記録も前のままなので、
            // ロックの中の手直し・その取り消しを、ロックを外した後に今の本編から読み取れる)
            overrides: mergeOverrideParts(
              overridesWithin(keptOverrides, locks, false),
              overridesWithin(project.cutOverrides, locks, true)
            )
          }
        : undefined
    )
    if (hasOverrides(overrides))
      log(
        `本編の手直しを当て直しました(削った区間 ${overrides!.removed.length}・足した区間 ${overrides!.added.length}・替えたカメラ ${overrides!.angles.length})`
      )
    // 取り消しで作り直しの前の本編に戻ったら、この作り直しで使った付け直しを使い直す
    if (released.touched.length > 0) usedTouches.set(project.clips, released.touched)
    appliedBuilds++
    set({
      roughCut: {
        keptIds: plan.selection.kept,
        kept: plan.selection.kept.length,
        dropped: plan.selection.dropped.length,
        duration: plan.cut.duration,
        shots: switches,
        telops: telops.length
      },
      // この回の残した場面を、組んだ本編の印と一緒に覚える(次の作り直しで、残す/落とすの変化を見る)
      builtKept: builtKeptWith(
        get().builtKept,
        cutSignature(useProjectStore.getState().project.roughCutAuto),
        plan.selection.kept
      ),
      // 付け直した印は、この作り直しで使ったものだけ消す(作っている間に触ったものは次に使う)
      keepTouched: get().keepTouched.filter((id) => (keepTouchedAt.get(id) ?? 0) > released.readAt),
      // 全体を作り直したので、範囲だけ自動編集した所も作り直した
      rangeRuns: [],
      // 作り直したので、古い形式の企画の案内(手で決めた残す/落とすは残っていない)はもう出さない
      restored: get().restored
        ? {
            ...get().restored!,
            legacy: false,
            missing: get().restored!.missing.filter((m) => !isLegacyNote(m))
          }
        : null
    })
    persistDecisions()
    // SE・BGM・CG は、仮編集を当てた後の本編(人が差し込んだクリップ・削った区間を含む)の時刻で置く。
    // 組んだだけの仮編集の時刻で置くと、差し込んだクリップの後ろが差し込んだ長さぶん早くずれる
    const applied = useProjectStore.getState().project
    const live =
      applied.multicam && applied.clips.length > 0
        ? spansOfClips(applied.clips, applied.multicam)
        : plan.cut.spans
    // SE・CG は、当てた後の企画に置かれたテロップ(人が消したもの・吹き出しにした発言を除き、直した文字の
    // まま)から置く。組んだだけのテロップから置くと、消したツッコミの効果音・CG が作り直すたびに付いていた
    const placedTelops = placedAutoTelops(applied.textOverlays)
    await placeSounds(
      plan.selection.kept,
      live,
      placedTelops.effects,
      placedTelops.all,
      locks.length > 0 ? lockedSoundWindows(project, applied, locks) : undefined
    )
    // SE・BGM・CG の工程の終わり方も覚える(開き直したとき「待機」にしない)
    persistDecisions()
    log(
      `仮編集を作りました: ${plan.selection.kept.length} 場面 · ${formatMinutes(plan.cut.duration)} · ショット ${switches} · 発言テロップ ${telops.length}`
    )
  }

  return {
    targetMinutes: 0,
    editNote: '',
    scenes: [],
    judgements: [],
    planJudgements: null,
    judgeSource: null,
    hype: [],
    keep: {},
    builtKept: [],
    keepTouched: [],
    rangeRuns: [],
    carriedTelops: [],
    sceneKind: null,
    roughCut: null,
    telopReviews: [],
    colorIssues: [],
    denoiseFailures: [],
    effects: [],
    effectChosen: [],
    lastSpans: [],
    speechTelops: [],
    restored: null,
    restoreFromProject: () => {
      if (get().running || get().scenes.length > 0) return
      const project = useProjectStore.getState().project
      // 番組の種類は設定にしか無いので、ゲーム実況で取り込んだ回(カメラの役割がある)はゲーム実況で切る
      const kind = project.multicam?.sources.some((src) => src.cameraRole)
        ? 'game'
        : useSettingsStore.getState().episodeKind
      const r = restorePipelineFromProject(project, kind, {
        kind: useSettingsStore.getState().episodeKind,
        policy: useSettingsStore.getState().editPolicy
      })
      if (!r) return
      set((s) => ({
        steps: { ...s.steps, ...r.steps },
        scenes: r.scenes,
        judgements: r.judgements,
        planJudgements: r.planJudgements,
        judgeSource: r.judgeSource,
        keep: r.keep,
        builtKept: r.builtKept,
        // 付け直しは丸ごと消した場面のものだけ(前の版で保存した企画には、クリップのある場面の付け直しも
        // 残っている。そのまま使うと、後で丸ごと消したときに付け直さなくても戻る)
        keepTouched: r.keepTouched.filter((id) => !ownedScenes(project, r.scenes).has(id)),
        carriedTelops: r.carriedTelops,
        sceneKind: project.autoEdit?.kind ?? kind,
        hype: r.hype,
        targetMinutes: r.targetMinutes,
        editNote: r.editNote,
        effects: r.effects,
        effectChosen: r.effectChosen,
        roughCut: r.roughCut,
        rangeRuns: project.autoEdit?.rangeRuns ?? [],
        restored: { missing: r.missing, legacy: r.legacy }
      }))
      log(
        r.legacy
          ? r.missing.some((m) => isLegacyNote(m) && m !== LEGACY_NOTE)
            ? '保存した企画から、自動編集の結果(工程・構成・保存されていた残す/落とす・判定・仮編集の要約)を読み直しました(前の版で保存した企画のため、作り直しで残した場面の記録はありません)'
            : '保存した企画から、自動編集の結果(工程・構成・仮編集の要約)を読み直しました(前の版で保存した企画のため、手で決めた残す/落とすは残っていません。作り直すと自動の選び方になります)'
          : '保存した企画から、自動編集の結果(工程・構成・判定・残す/落とす・仕上がりの長さ・演出テロップの提案)を読み直しました'
      )
    },
    setEffectChosen: (id, chosen) => {
      const project = useProjectStore.getState().project
      const spans = project.multicam ? spansOfClips(project.clips, project.multicam) : []
      // 選んだ印は、今の企画に置いてある演出テロップに合わせる。取り消し(Ctrl+Z)で企画から外れた
      // 演出テロップを、選んだままと覚えていると、次に別の提案を選んだときに一緒に戻ってくる
      let base = get().effectChosen
      if (project.multicam && spans.length > 0) {
        const placed = new Set(project.textOverlays.map((o) => o.effectId).filter(Boolean))
        const dismissed = new Set(project.dismissedTelops ?? [])
        const wouldPlace = new Set(
          effectOverlays(
            get().effects,
            new Set(base),
            project,
            project.multicam,
            spans,
            usePresetStore.getState().captionPresets
          ).map((o) => o.effectId)
        )
        base = base.filter((x) => !wouldPlace.has(x) || placed.has(x) || dismissed.has(`e:${x}`))
      }
      const next = chosen ? [...new Set([...base, id])] : base.filter((x) => x !== id)
      set({ effectChosen: next })
      persistDecisions()
      // 対応は今の本編から作る(作り直したあとに元に戻す・手で詰めると、覚えていた対応は古い)
      if (!project.multicam || spans.length === 0) {
        // 置けないときも、選び直したら前に手で消した印は外す
        if (chosen) useProjectStore.getState().undismissTelops([`e:${id}`])
        return
      }
      // 選び直したら、前に手で消していても置き直す(置き直しと同じ1回の取り消しで戻る)
      const undismissed = chosen
        ? {
            ...project,
            dismissedTelops: (project.dismissedTelops ?? []).filter((k) => k !== `e:${id}`)
          }
        : project
      // 吹き出しは発言テロップの代わりに出す: 選んだら発言テロップを外し、外したら戻す
      const fx = get().effects.find((e) => e.id === id)
      const speech =
        fx?.kind === 'bubble'
          ? {
              utteranceId: fx.afterLineId,
              // 覚えている発言テロップは仮編集を入れたときの時刻なので、今の本編の位置へ写す
              // (そのあと本編を手で詰めた・差し込みの画がある、で位置が変わっている)
              telops: chosen
                ? []
                : mapTelopsToTimeline(
                    get().speechTelops.filter((o) => o.utteranceId === fx.afterLineId),
                    get().lastSpans,
                    spans
                  )
            }
          : undefined
      useProjectStore
        .getState()
        .setEffectTelops(
          effectOverlays(
            get().effects,
            new Set(next),
            undismissed,
            project.multicam,
            spans,
            usePresetStore.getState().captionPresets
          ),
          speech,
          chosen ? [`e:${id}`] : undefined
        )
    },
    setTargetMinutes: (minutes) => {
      const next = Math.max(0, minutes)
      set((s) => (s.targetMinutes === next ? {} : { targetMinutes: next }))
      persistDecisions()
    },
    setEditNote: (note) => {
      set({ editNote: note })
      persistDecisions()
    },
    setKeep: (sceneId, keep) => {
      set((s) => {
        const next = { ...s.keep }
        if (keep === undefined) delete next[sceneId]
        else next[sceneId] = keep
        // 付け直しを覚えるのは、丸ごと消した(本編にクリップが無い)場面だけ。クリップがある場面の
        // チェックを外して付け直しても、その後で丸ごと消したのを戻す根拠にしない
        const emptied = !ownedScenes(useProjectStore.getState().project, s.scenes).has(sceneId)
        if (!emptied) return { keep: next }
        keepTouchedAt.set(sceneId, ++keepTouchClock)
        // 戻した付け直しに触り直しても、元の記録との結び付きは残す(場面にクリップが戻って捨てたら、
        // 元の記録からも外す。外さないと、やり直しでまた戻る)
        return {
          keep: next,
          keepTouched: s.keepTouched.includes(sceneId) ? s.keepTouched : [...s.keepTouched, sceneId]
        }
      })
      persistDecisions()
    },
    shorts: { state: 'idle', done: 0, total: 0, files: [] },
    makeShorts: async (folder, options) => {
      const project = useProjectStore.getState().project
      const info = project.multicam
      if (!info || get().shorts.state === 'run') return []
      set({
        shorts: { state: 'run', done: 0, total: 0, files: [], note: '見どころを探しています' }
      })
      const files: string[] = []
      try {
        const activity = await activityOf(project, info)
        // 声の盛り上がりは、構成の判定で測ったもの。測っていなければ(ロケとして作った回)ここで測る
        const hype = get().hype.length > 0 ? get().hype : hypeMomentsFor(project, info, activity)
        const windows = shortWindowsFor({ project, info, hype }, options)
        if (windows.length === 0) {
          set({
            shorts: {
              state: 'done',
              done: 0,
              total: 0,
              files,
              note: '盛り上がった所が見つかりませんでした'
            }
          })
          return files
        }
        const settings = useSettingsStore.getState()
        const styles = usePresetStore.getState().captionPresets
        // 本編の人の修正(削った・足した区間、替えたカメラ)。仮編集の作り直しと同じく読み取る
        const overrides = project.roughCutAuto
          ? updateOverrides(
              project.cutOverrides,
              project.roughCutAuto,
              coverageOfClips(project.clips, info)
            )
          : project.cutOverrides
        for (let i = 0; i < windows.length; i++) {
          set({
            shorts: {
              state: 'run',
              done: i,
              total: windows.length,
              files: [...files],
              note: `${i + 1}/${windows.length} 本目を書き出し中`
            }
          })
          let short = buildShortProject(
            {
              project,
              info,
              hype,
              activity,
              overrides,
              styles,
              speechLook: speechLook(settings.speechTelopLook, styles),
              dictionary: parseDictionary(settings.telopDictionary)
            },
            windows[i],
            i
          )
          // ロケ・対談の回は、真ん中ではなく人物(顔)に寄せて縦に切り出す(ゲーム実況はゲーム画面の真ん中)
          if (settings.episodeKind !== 'game' && settings.verticalFraming === 'fill')
            short = (
              await prepareVerticalFill({
                ...short,
                clips: short.clips.map((c) => ({ ...c, fillCrop: undefined }))
              })
            ).project
          const base = await freeShortBase(`${folder}/${safeFileBaseName(short.name)}`)
          await window.api.saveProject(`${base}.veproj`, short)
          const telopLayer = await prepareTelopLayerForExport(short, '9:16', 1080)
          try {
            await window.api.exportProject({
              project: short,
              aspectRatio: '9:16',
              resolutionHeight: 1080,
              quality: settings.exportQuality,
              outputPath: `${base}.mp4`,
              loudnessNormalization: settings.exportLoudness !== 'off',
              loudnessTarget:
                settings.exportLoudness === 'off' ? undefined : settings.exportLoudness,
              engine: settings.exportEngine,
              telopLayer
            })
          } finally {
            if (telopLayer?.stagedId)
              void window.api.telopLayer.release(telopLayer.stagedId).catch(() => {})
          }
          files.push(`${base}.mp4`)
          log(
            `ショート ${i + 1}: ${clockText(windows[i].start)}〜${clockText(windows[i].end)}(山 ${windows[i].peaks} 回)→ ${base}.mp4`
          )
        }
        set({ shorts: { state: 'done', done: files.length, total: files.length, files } })
        return files
      } catch (e) {
        const msg = formatIpcError(e)
        log(`ショートを作れませんでした: ${msg}`)
        set({
          shorts: { state: 'error', done: files.length, total: files.length, files, note: msg }
        })
        return files
      }
    },
    rebuildRoughCut: async () => {
      if (get().running || get().scenes.length === 0) return
      runCanceled = false
      set({ running: true })
      let recut = false
      try {
        // 開き直した企画のゲーム実況は、声の盛り上がりを測り直してから(山の前後に絞るのに使う)
        const project = useProjectStore.getState().project
        const kind = useSettingsStore.getState().episodeKind
        if (
          get().restored?.legacy &&
          kind === 'game' &&
          get().hype.length === 0 &&
          project.multicam
        ) {
          setStep('cut', { state: 'run', percent: 0, note: '声の盛り上がりを測っています' })
          const hype = hypeMomentsFor(
            project,
            project.multicam,
            await activityOf(project, project.multicam)
          )
          const scenes = scenesFor(project, project.multicam, { kind, hype })
          // 切り直した場面に、残す/落とすを当て直す(時刻がほぼ同じ場面だけ。ID は番号なので別の場面を指す)
          const match = matchScenesByTime(get().scenes, scenes)
          set({
            hype,
            scenes,
            judgements: heuristicJudgements(scenes, kind),
            keep: remapSceneFlags(get().keep, match),
            builtKept: get().builtKept.map((b) => ({
              cut: b.cut,
              keptIds: remapKept(b.keptIds, match)
            })),
            keepTouched: remapKept(get().keepTouched, match),
            sceneKind: kind
          })
          recut = true
        }
        const applied = appliedBuilds
        await buildAndApply()
        // 切り直した場面で作り直しが当たったら、前の場面の ID の記録は使わない(当たらなければそのまま)
        if (recut && appliedBuilds !== applied) forgetUsedTouches()
      } catch (e) {
        const msg = formatIpcError(e)
        // 中止した(このPCの AI の提案を止めた など)なら、動いていた工程を「中止しました」に戻す。
        // 済んでいた工程(アングル)に失敗の印を付けない
        const current = REBUILD_STEPS.find((id) => get().steps[id].state === 'run')
        if (isCanceled(msg)) {
          if (current) setStep(current, { state: 'wait', note: '中止しました' })
          log('仮編集の作り直しを中止しました')
        } else {
          setStep(current ?? 'angles', { state: 'error', note: msg })
          log(`仮編集を作り直せませんでした: ${msg}`)
        }
      } finally {
        set({ running: false })
      }
    },
    asrDevice: null,
    root: null,
    scanTracks: null,
    scan: null,
    sources: [],
    steps: initialSteps(),
    report: null,
    syncedFiles: [],
    log: [],
    running: false,
    screenOpen: false,
    screenView: 'auto',

    addLog: (text) => log(text),
    setScreenOpen: (open) => set({ screenOpen: open }),
    setScreenView: (view) => set({ screenView: view }),

    resetResults: () => {
      activityCache = null
      runGeneration++
      set((s) => ({
        // 取り込み(フォルダの読み取り)の結果は残す。それより後の工程の結果だけ捨てる
        steps: { ...initialSteps(), ingest: s.steps.ingest },
        // 前の回のショートの結果(書き出したファイルの一覧)も捨てる。書き出している最中なら残す
        shorts:
          s.shorts.state === 'run' ? s.shorts : { state: 'idle', done: 0, total: 0, files: [] },
        report: null,
        scenes: [],
        judgements: [],
        planJudgements: null,
        judgeSource: null,
        hype: [],
        keep: {},
        builtKept: [],
        keepTouched: [],
        rangeRuns: [],
        rangeReview: null,
        carriedTelops: [],
        sceneKind: null,
        // 仕上がりの長さ・方針は人が入れたものなので、ここでは捨てない(新しい回の画面・自動編集の画面で
        // 決めてすぐ始めると、始めるときにここで捨てていた)。企画を替えたときだけ入れ替える
        roughCut: null,
        telopReviews: [],
        colorIssues: [],
        denoiseFailures: [],
        effects: [],
        effectChosen: [],
        lastSpans: [],
        speechTelops: [],
        restored: null
      }))
    },

    dropScan: () => {
      scanToken++
      set((s) => ({
        root: null,
        scanTracks: null,
        scan: null,
        sources: [],
        syncedFiles: [],
        steps: { ...s.steps, ingest: { state: 'wait', percent: 0 } }
      }))
    },

    reset: () => {
      // 読んでいる最中の収録フォルダの結果は捨てる(新しい回の画面に前のフォルダが出ないように)
      scanToken++
      set({
        shorts: { state: 'idle', done: 0, total: 0, files: [] },
        root: null,
        scanTracks: null,
        scan: null,
        sources: [],
        steps: initialSteps(),
        report: null,
        syncedFiles: [],
        log: [],
        scenes: [],
        judgements: [],
        planJudgements: null,
        judgeSource: null,
        hype: [],
        keep: {},
        builtKept: [],
        keepTouched: [],
        rangeRuns: [],
        rangeReview: null,
        carriedTelops: [],
        sceneKind: null,
        roughCut: null,
        telopReviews: [],
        colorIssues: [],
        denoiseFailures: [],
        effects: [],
        effectChosen: [],
        lastSpans: [],
        speechTelops: [],
        restored: null
      })
    },

    scanFolder: async (root) => {
      const token = ++scanToken
      // 同じフォルダを読み直すときは、人が直した役割(使わない・顔カメラ・誰を映すか など)を引き継ぐ
      const edited = get().root === root ? get().sources : []
      // 音声トラックを分けるのはゲーム実況だけ(OBS の録画)
      const tracks = useSettingsStore.getState().episodeKind === 'game'
      set({ root, scan: null, sources: [], steps: initialSteps(), report: null })
      setStep('ingest', { state: 'run', percent: 0, note: 'ファイルを探しています' })
      log(`収録フォルダを読み込みます: ${root}`)
      const off = window.api.onFootageScanProgress(({ done, total }) =>
        setStep('ingest', { percent: (done / Math.max(1, total)) * 100, note: `${done}/${total}` })
      )
      try {
        const scan = await window.api.footageScan(root, { tracks })
        // 読んでいる間に別のフォルダ・読み直しが始まったら、この結果は捨てる
        if (token !== scanToken) return
        // 読んでいる間に番組の種類が替わったら(トラックを分けるかが変わる)、読み直す
        if ((useSettingsStore.getState().episodeKind === 'game') !== tracks) {
          set({ sources: edited })
          return get().scanFolder(root)
        }
        const remembered = readSourceNames()
        const sources: EditableSource[] = scan.sources
          .map((s: FootageSource) => ({
            id: s.id,
            name: remembered[s.id] ?? s.name,
            kind: s.kind,
            basis: s.basis,
            files: s.files,
            ...(s.trackRole ? { trackRole: s.trackRole } : {}),
            ...(s.cameraRole ? { cameraRole: s.cameraRole } : {})
          }))
          .map((s) => {
            const prev = edited.find((x) => x.id === s.id)
            if (!prev) return s
            return {
              ...s,
              kind: prev.kind,
              subject: prev.subject,
              trackRole: prev.trackRole,
              cameraRole: prev.cameraRole
            }
          })
        set({ scan, sources, scanTracks: tracks })
        const count = sources.reduce((n, s) => n + s.files.length, 0)
        setStep('ingest', {
          state: 'done',
          percent: 100,
          note: `${sources.length} 系統 · ${count} 本${scan.skipped.length ? ` · 読めない ${scan.skipped.length} 本` : ''}`
        })
        log(
          `見つかった素材: ${sources.map((s) => `${s.name}(${s.files.length}本)`).join('、') || 'なし'}`
        )
        for (const sk of scan.skipped) log(`読み込めない: ${sk.path}(${sk.reason})`)
      } catch (e) {
        if (token !== scanToken) return
        setStep('ingest', { state: 'error', note: formatIpcError(e) })
        log(`取り込みに失敗: ${formatIpcError(e)}`)
      } finally {
        off()
      }
    },

    updateSource: (id, patch) => {
      if (patch.name !== undefined && patch.name.trim()) rememberSourceName(id, patch.name.trim())
      set((s) => ({ sources: s.sources.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))
    },

    runPipeline: async () => {
      // 読んだ後に番組の種類が替わっていたら(音声トラックを分けるかが違う)、読み直してから始める
      {
        const { root, scan, scanTracks, running } = get()
        if (
          !running &&
          root &&
          scan &&
          scanTracks !== (useSettingsStore.getState().episodeKind === 'game')
        ) {
          await get().scanFolder(root)
          if (get().steps.ingest.state !== 'done') return
        }
      }
      const { scan, sources, running } = get()
      if (running || !scan) return
      const used = sources.filter((s) => s.kind !== 'skip')
      const files: SyncInputFile[] = used.flatMap((s) =>
        s.files.map((f) => ({
          id: f.path,
          path: f.path,
          sourceId: s.id,
          sourceKind: s.kind as SourceKind,
          duration: f.duration,
          recordedAt: f.recordedAt,
          size: f.size,
          mtimeMs: scan.stats[f.path]?.mtimeMs ?? 0
        }))
      )
      if (!used.some((s) => s.kind === 'camera')) {
        setStep('sync', { state: 'error', note: 'カメラの素材がありません' })
        return
      }
      // やり直すときは、前の回の結果(構成・提案・要確認・音の有無の目印)を捨ててから始める。
      // 残すと「提案は済んだ」と飛ばされ、前の発話に付いた提案は新しい発話に結び付かずに全部消える
      get().resetResults()
      const generation = runGeneration
      runCanceled = false
      set({ running: true, report: null, syncedFiles: files })

      // --- 同期
      setStep('sync', { state: 'run', percent: 0, note: '準備中' })
      setStep('timeline', { state: 'wait', percent: 0, note: undefined })
      log(`同期を始めます(${files.length} 本)`)
      const off = window.api.onSyncProgress(({ percent, stage }) =>
        setStep('sync', { percent, note: stage })
      )
      let report: SyncReport
      try {
        // 動画から取り出した音声トラックは、元の動画と同じ時計・同じ頭なので照らし合わせない
        // (声だけ・ゲーム音だけのトラックは元の動画の音と似ておらず、照らし合わせると外れることがある)
        // 元の動画を「使わない」にしたトラックは、ほかの素材と同じく照らし合わせる
        const inSync = new Set(files.map((f) => f.path))
        const parentOf = trackParentMap(used, inSync)
        const synced = await window.api.syncRun(files.filter((f) => !parentOf.has(f.path)))
        report = withTrackPlacements(synced, files, parentOf)
      } catch (e) {
        const msg = formatIpcError(e)
        const canceled = msg.includes('SYNC_CANCELED')
        // 別のプロジェクトを開いて結果を捨てた後なら、そのプロジェクトの工程には書かない
        if (generation === runGeneration)
          setStep('sync', {
            state: canceled ? 'wait' : 'error',
            note: canceled ? '中止しました' : msg
          })
        log(canceled ? '同期を中止しました' : `同期に失敗: ${msg}`)
        set({ running: false })
        return
      } finally {
        off()
      }
      const synced = report.placements.filter((p) => p.method !== 'none').length
      set({ report })
      setStep('sync', {
        state: 'done',
        percent: 100,
        note: `${synced}/${files.length} 本を同期 · ${(report.elapsedMs / 1000).toFixed(1)} 秒`
      })
      log(`同期が終わりました: ${synced}/${files.length} 本(要確認 ${report.issues.length} 件)`)
      for (const p of report.pairs) {
        if (p.driftPpm !== undefined && Math.abs(p.driftPpm) >= 20) {
          log(
            `時計のずれ: ${fileName(p.b)} は ${fileName(p.a)} に対して ${p.driftPpm.toFixed(0)}ppm(1時間で ${(((Math.abs(p.driftPpm) * 3600) / 1e6) * 1000).toFixed(0)}ms)`
          )
        }
      }

      // --- タイムラインに並べる
      setStep('timeline', { state: 'run', percent: 0, note: '素材を読み込み中' })
      try {
        const gameKind = useSettingsStore.getState().episodeKind === 'game'
        const layout = buildMulticamLayout(
          used.map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind as SourceKind,
            // ゲーム実況は、ゲーム画面を本編(基準カメラ)にする(顔カメラはワイプ)
            preferAnchor: gameKind && s.kind === 'camera' && s.cameraRole !== 'face'
          })),
          files.map((f) => ({ id: f.id, sourceId: f.sourceId, duration: f.duration })),
          report.placements
        )
        if (!layout) throw new Error('同期できたカメラがありません')
        const assets: MediaAsset[] = []
        const assetIdOf: Record<string, string> = {}
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          const meta = await window.api.probeMedia(f.path)
          // 中止した・別のプロジェクトを開いたなら、そこで止める(止めないと、開いたプロジェクトに
          // 前の回の素材を並べていた)
          stopIfCanceled()
          let thumbnailDataUrl: string | undefined
          if (meta.hasVideo) {
            thumbnailDataUrl = await window.api
              .generateThumbnail(f.path, Math.min(1, meta.duration / 2))
              .catch(() => undefined)
            stopIfCanceled()
          }
          const id = uuid()
          assetIdOf[f.id] = id
          assets.push({
            id,
            filePath: f.path,
            fileName: fileName(f.path),
            duration: meta.duration,
            width: meta.width,
            height: meta.height,
            fps: meta.fps,
            hasAudio: meta.hasAudio,
            hasVideo: meta.hasVideo,
            thumbnailDataUrl
          })
          setStep('timeline', { percent: ((i + 1) / files.length) * 90 })
        }
        // 縦横比は基準カメラに合わせる(新しい回は既定の縦型のままだと、全素材が「縦横比が違う」になる)
        const anchorAsset = assets.find((a) => a.id === assetIdOf[layout.main[0]?.fileId ?? ''])
        const aspect =
          anchorAsset && anchorAsset.width > 0 && anchorAsset.height > 0
            ? anchorAsset.width >= anchorAsset.height
              ? '16:9'
              : '9:16'
            : undefined
        useProjectStore.getState().addMulticamTimeline(
          assets,
          layout,
          assetIdOf,
          aspect,
          used.map((u) => ({
            id: u.id,
            name: u.name,
            kind: u.kind as SourceKind,
            subject: u.subject,
            ...(u.trackRole ? { trackRole: u.trackRole } : {}),
            // 元の動画は「使わない」にしたカメラでもよい(同じ録画のトラックどうしで鳴らし分ける)
            ...(trackParentSource(u, sources) ? { trackOf: trackParentSource(u, sources) } : {}),
            ...(gameKind && u.kind === 'camera'
              ? { cameraRole: u.cameraRole === 'face' ? ('face' as const) : ('screen' as const) }
              : {})
          }))
        )
        // 撮影開始の時刻を企画に覚える(開き直しても時刻スーパーを出せるように)。人の操作ではないので履歴に積まない
        {
          const p = useProjectStore.getState().project
          const times = recordedAtByAsset(p, files)
          if (p.multicam && times.size > 0)
            useProjectStore.setState({
              project: {
                ...p,
                multicam: {
                  ...p.multicam,
                  files: p.multicam.files.map((f) =>
                    times.has(f.assetId) ? { ...f, recordedAt: times.get(f.assetId) } : f
                  )
                }
              }
            })
        }
        // 再生できない形式(HEVC など)は、素材一覧の側でプレビュー用の変換を始める
        emitMenuCommand('assets.checkPreview')
        void window.api.libraryRemember(assets.map((a) => a.filePath)).catch(() => {})
        setStep('timeline', {
          state: 'done',
          percent: 100,
          note: `カメラ ${layout.cameras.length + 1} 台(基準カメラの素材 ${layout.main.length} 本) · マイク ${layout.mics.length} 本${layout.leftOut.length ? ` · 並べなかった ${layout.leftOut.length} 本` : ''}`
        })
        log(
          `タイムラインに並べました(基準カメラ: ${used.find((s) => s.id === layout.anchorSourceId)?.name ?? ''})`
        )
        // 工程の間で中止を確かめる(中止しても、走っていた工程が答えを返して先へ進んでいた)
        await matchColors()
        stopIfCanceled()
        await denoiseMics()
        stopIfCanceled()
        await transcribeEpisode(used, files, report, assetIdOf, layout.anchorSourceId)
        stopIfCanceled()
        await detectEvents()
        stopIfCanceled()
        await structureAndCut()
      } catch (e) {
        const msg = formatIpcError(e)
        const current = (
          [
            'effects',
            'sound',
            'timeline',
            'color',
            'denoise',
            'speakers',
            'transcribe',
            'events',
            'structure',
            'cut',
            'angles',
            'placement'
          ] as StepId[]
        ).find((id) => get().steps[id].state === 'run')
        const canceled = isCanceled(msg)
        if (current && generation === runGeneration)
          setStep(current, {
            state: canceled ? 'wait' : 'error',
            note: canceled ? '中止しました' : msg
          })
        // 別のプロジェクトを開いて結果を捨てた後なら、そのプロジェクトの工程には書かない
        else if (canceled && generation === runGeneration) {
          // 工程の合間に中止したときも、次の工程に「中止しました」を出す(出さないと、終わったと
          // 知らせていた)
          const next = STEPS.find((st) => get().steps[st.id].state === 'wait')
          if (next) setStep(next.id, { note: '中止しました' })
        }
        log(canceled ? '自動編集を中止しました' : `止まりました: ${msg}`)
      } finally {
        set({ running: false })
      }
    },

    cancel: () => {
      runCanceled = true
      void window.api.syncCancel()
      void window.api.asrCancel()
      void window.api.eventsCancel()
      // このPCの AI(構成・演出テロップ)とノイズ除去も止める
      void window.api.llmCancel()
      cancelAiRequests()
      void window.api.denoiseCancel()
    },

    // 確認済みはプロジェクトに保存する(開き直しても残る)
    rangeReview: null,
    closeRangeReview: () => set({ rangeReview: null }),
    prepareRangedEdit: async (requested, options, how) => {
      const r = await get().prepareRangedVariants(requested, options, {
        exact: how?.exact,
        only: 'A'
      })
      return r.ok
        ? { ok: true, preview: r.previews[0] }
        : { ok: false, reason: r.reason, ...(r.needsRipple ? { needsRipple: true } : {}) }
    },
    prepareRangedVariants: async (requested, options, how) => {
      const project = useProjectStore.getState().project
      const info = project.multicam
      const blocked = rangedEditBlockedReason(project, get())
      if (blocked || !info) return { ok: false, reason: blocked ?? '使えません' }
      const activity = await activityOf(project, info)
      const range = how?.exact
        ? { start: requested.start, end: requested.end }
        : snapRangeBoundaries(project, requested, levelOf(activity))
      const cw = commonWindowOf(project.clips, info, range)
      if (!cw.ok) return { ok: false, reason: cw.reason }
      const win = cw.window
      if (
        (project.autoEditLocks ?? []).some(
          (l) => Math.min(l.end, win.end) - Math.max(l.start, win.start) > 1e-3
        )
      )
        return {
          ok: false,
          reason:
            '範囲に、自動編集で触らない所(ロック)が入っています。ロックを外すか、ロックの外で範囲を選んでください'
        }
      const steps = options.steps
      const scenes = get().scenes
      const inWindow = clipScenesToWindow(scenes, win)
      const sceneIds = inWindow.map((sc) => sc.id)
      const fullScenes = scenes
        .filter((sc) => sc.start >= win.start - 1e-6 && sc.end <= win.end + 1e-6)
        .map((sc) => sc.id)
      // 当てる前に残していた場面(当てる時の記録と同じ読み方)
      const keptBeforeIds = new Set(keptScenesOf(project))
      // 本編の修正: 範囲の中の手直しを残すなら、作り直しと同じく今の本編から読み取った判断の、窓の中だけ。
      // カットをやり直さないなら今の残し方に、アングルをやり直さないなら今のカメラに固定する
      const current = coverageOfClips(project.clips, info)
      // 窓の中の人の手直し(作り直しと同じく今の本編から読み取ったもの)
      const released = releasedKeep(project)
      const read = overridesWithin(
        releaseOverridesForScenes(
          project.roughCutAuto
            ? updateOverrides(project.cutOverrides, project.roughCutAuto, current)
            : project.cutOverrides,
          released.scenes,
          released.keep
        ),
        [win]
      )
      const kept = options.keepInside ? read : undefined
      // 企画に覚え直す窓の中の手直し。残すときは全部。カット・アングルをやり直さない(今の中身に固定する)
      // ときは、その種類の手直しを残す(覚えないと、固定した中身が「自動」になり、手直しが次の全体の
      // 作り直しで戻る)
      const remembered: CutOverrides | undefined = read
        ? {
            removed: options.keepInside || !steps.cut ? read.removed : [],
            added: options.keepInside || !steps.cut ? read.added : [],
            angles: options.keepInside || !steps.angles ? read.angles : []
          }
        : undefined
      let overrides = kept
      if (!steps.cut || !steps.angles) {
        // 固定するのは範囲の中の今の中身だけ(範囲の外にある、窓の中の時刻を映すクリップ(複製・並べ替え)
        // まで入れると、外の複製のカメラ・区間で範囲の中が替わっていた)
        const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
        const insideNow: CameraSeg[] = cw.pieces.flatMap((pc) => {
          const f = fileOf.get(project.clips[pc.clipIndex].assetId)
          return f ? [{ start: pc.start, end: pc.end, cameraId: f.sourceId }] : []
        })
        const pin = pinOverrides([win], insideNow)
        overrides = {
          removed: steps.cut ? (kept?.removed ?? []) : pin.removed,
          added: steps.cut ? (kept?.added ?? []) : pin.added,
          angles: steps.angles ? (kept?.angles ?? []) : pin.angles
        }
      }
      // 仕上がりの長さ: 長さを保つなら範囲の長さ(差し込みの画の分を除く)。リップルなら、全体の目標を
      // 範囲の場面の長さの割合で分けたもの(目標が無ければ決めない)
      const times = clipTimes(project.clips)
      const files = new Set(info.files.map((f) => f.assetId))
      const extrasLen = project.clips.reduce((t, c, i) => {
        if (files.has(c.assetId)) return t
        return (
          t + Math.max(0, Math.min(times[i].end, range.end) - Math.max(times[i].start, range.start))
        )
      }, 0)
      const fitSec = Math.max(0, range.end - range.start - extrasLen)
      const sceneLen = (list: readonly { start: number; end: number }[]): number =>
        list.reduce((t, sc) => t + (sc.end - sc.start), 0)
      const baseTarget = options.keepLength
        ? fitSec
        : get().targetMinutes > 0
          ? (get().targetMinutes * 60 * sceneLen(inWindow)) / Math.max(1e-9, sceneLen(scenes))
          : 0
      // 番組素材フォルダの中身は案ごとに読まない
      let kitScan: ReturnType<typeof window.api.showKitScan> | undefined
      const makeOne = async (spec: RangedVariantSpec): Promise<RangedPrepareResult> => {
        const targetSec = options.keepLength ? baseTarget : baseTarget * spec.targetScale
        const plan = planRoughCut(project, info, inWindow, get().judgements, activity, {
          overrides,
          targetSec,
          keep: get().keep,
          styles: usePresetStore.getState().captionPresets,
          speechLook: speechLook(
            useSettingsStore.getState().speechTelopLook,
            usePresetStore.getState().captionPresets
          ),
          dictionary: parseDictionary(useSettingsStore.getState().telopDictionary),
          style: useSettingsStore.getState().showStyle?.style,
          kind: useSettingsStore.getState().episodeKind,
          policy: spec.policy,
          ...(spec.pauseScale !== 1 ? { pauseScale: spec.pauseScale } : {}),
          peaks: peakSpans(get().hype, project.audioEvents),
          window: {
            start: win.start,
            end: win.end,
            // カットをやり直さないときも(速さを戻したクリップ・固定した中身で長さが変わる)
            ...(options.keepLength ? { fitSec } : {})
          }
        })
        if (plan.cut.main.length === 0)
          return {
            ok: false,
            reason:
              '範囲の中に残す所がありません(構成で範囲の場面を「残す」にするか、範囲を広げてください)'
          }
        const frame = frameSeconds(project.clips, project.assets)
        if (options.keepLength && (plan.fitShort ?? 0) > frame)
          return {
            ok: false,
            needsRipple: true,
            reason: `範囲の中の素材では、元の長さに ${plan.fitShort!.toFixed(1)} 秒足りません。後ろを詰めて(リップル)当てますか?`
          }
        // 発言テロップ: 顔(ゲーム実況なら画面の表示)を避けた位置へ。調べられなければ下のまま
        let telops = steps.speech ? plan.telops : []
        if (telops.length > 0) {
          if (useSettingsStore.getState().episodeKind === 'game')
            try {
              telops = (
                await placeTelopsAvoidingHud(telops, plan.cut, project.assets, project.aspectRatio)
              ).telops
            } catch {
              // 下のまま
            }
          try {
            telops = (
              await placeTelopsAvoidingFaces(telops, plan.cut, project.assets, project.aspectRatio)
            ).telops
          } catch {
            // 下のまま
          }
        }
        const bubbled = bubbledUtterances(
          get().effects,
          get().effectChosen,
          project.dismissedTelops
        )
        const proposals = new Set(get().effects.map((e) => e.id))
        const effectTelops = steps.effects
          ? effectOverlays(
              get().effects,
              new Set(get().effectChosen),
              project,
              info,
              plan.cut.spans,
              usePresetStore.getState().captionPresets
            )
          : []
        if (useProjectStore.getState().project.clips !== project.clips)
          return {
            ok: false,
            reason: '用意している間に本編が直されたため、やめました。もう一度選んでください'
          }
        const result = rangedEditProject(project, {
          range,
          window: win,
          cut: plan.cut,
          telops: [
            ...telops.filter((o) => !o.utteranceId || !bubbled.has(o.utteranceId)),
            ...effectTelops
          ],
          keepLength: options.keepLength,
          keptOverrides: remembered,
          replaceTelop: (o) =>
            o.utteranceId ? steps.speech : steps.effects && proposals.has(o.effectId ?? '')
        })
        // 長さを保つで、窓の中の素材で埋めきれなかった(素材の終わり・窓の終わりで止めた)ならリップルを勧める
        if (options.keepLength && result.lengthShort > frame)
          return {
            ok: false,
            needsRipple: true,
            reason: `範囲の中の素材では、元の長さに ${result.lengthShort.toFixed(1)} 秒足りません。後ろを詰めて(リップル)当てますか?`
          }
        let after = result.project
        const skipped: string[] = []
        // SE・CG・BGM: 範囲の中だけ置き直す(番組素材フォルダがあるとき)
        const folder = useSettingsStore.getState().showKitFolder
        if (folder && (steps.se || steps.cg || steps.bgm)) {
          try {
            kitScan ??= window.api.showKitScan(folder)
            const kit = await kitScan
            const nr = result.range
            const style = useSettingsStore.getState().showStyle?.style
            const spans = spansOfClips(after.clips, info)
            const keptScenes = inWindow.filter((sc) => plan.selection.kept.includes(sc.id))
            const judged = new Map(
              (get().planJudgements ?? get().judgements).map((j) => [j.sceneId, j])
            )
            const sceneRanges = keptScenes
              .map((sc) => {
                const r = timelineRangeOf(spans, sc.start, sc.end)
                const j = judged.get(sc.id)
                const original = scenes.find((x) => x.id === sc.id)
                return r
                  ? {
                      start: Math.max(r.start, nr.start),
                      end: Math.min(r.end, nr.end),
                      mood: j?.mood ?? fallbackMood(j?.kind ?? 'normal'),
                      // 場面の本当の頭か(範囲の境で切った頭には場面転換の SE を置かない)
                      head: (original?.start ?? sc.start) >= win.start - 1e-6
                    }
                  : null
              })
              .filter((x): x is NonNullable<typeof x> => x !== null && x.end > x.start)
            const inRange = (t: number): boolean => t >= nr.start - 1e-6 && t < nr.end - 1e-6
            const placed = placedAutoTelops(after.textOverlays)
            const kindOf = new Map(get().effects.map((e) => [e.id, e.kind]))
            const se = steps.se
              ? planSoundEffects(
                  placed.effects
                    .filter((t) => t.effectId && kindOf.has(t.effectId) && inRange(t.startTime))
                    .map((t) => ({
                      time: t.startTime,
                      kind: kindOf.get(t.effectId!)!,
                      text: t.text
                    })),
                  sceneRanges.filter((x) => x.head).map((x) => x.start),
                  kit,
                  style
                    ? { perMinute: style.sePerMinute, durationSec: nr.end - nr.start }
                    : undefined
                ).filter((x) => inRange(x.startTime))
              : undefined
            const cg = steps.cg
              ? planCg(
                  placed.all.filter((t) => inRange(t.startTime)),
                  kit.cg
                )
              : undefined
            const bgm = steps.bgm ? planBgm(sceneRanges, kit, style?.bgmVolume) : undefined
            const assets = await loadKitAssets(
              [...(se ?? []), ...(cg ?? []), ...(bgm ?? [])].map((x) => x.path)
            )
            const r = withRangedSounds(after, nr, { se, cg, bgm }, assets)
            after = r.project
            const names = { se: 'SE', bgm: 'BGM', cg: 'CG' } as const
            skipped.push(...r.skipped.map((k) => names[k]))
          } catch (e) {
            log(
              `範囲の SE・BGM・CG を置けませんでした(本編とテロップは作り直します): ${formatIpcError(e)}`
            )
          }
        }
        if (useProjectStore.getState().project.clips !== project.clips)
          return {
            ok: false,
            reason: '用意している間に本編が直されたため、やめました。もう一度選んでください'
          }
        // 終わったらロックする: 当てるのと同じ1回の取り消しで戻るよう、当てる企画に入れておく
        // ロックするのは、選んだタイムラインの範囲に当てた後の中身の所だけ(落とした場面をまたいだ窓の
        // 全体ではない)。ほかのロックとはまとめない
        if (options.lockAfter) {
          const lockWin = commonWindowOf(after.clips, info, result.range)
          const w = lockWin.ok ? lockWin.window : win
          after = {
            ...after,
            autoEditLocks: [
              ...(after.autoEditLocks ?? []),
              { id: uuid(), start: w.start, end: w.end }
            ]
          }
        }
        const summary = summarizeRangedEdit(project, after, range, result.range, {
          movedHand: result.movedHand,
          insideHand: result.insideHand,
          speedChanged: cw.speedChanged,
          outsideOverlap: cw.outsideOverlap,
          skipped
        })
        return {
          ok: true,
          preview: {
            base: project,
            after,
            range,
            newRange: result.range,
            window: win,
            options,
            summary,
            keptIds: plan.selection.kept,
            sceneIds,
            fullScenes,
            usedTouches: get().keepTouched.filter((id) => sceneIds.includes(id)),
            variant: { id: spec.id, label: spec.label, note: spec.note, merged: [] },
            keptBefore: sceneIds.filter((id) => keptBeforeIds.has(id)).length,
            restored: (() => {
              const back = inWindow.filter(
                (sc) => plan.selection.kept.includes(sc.id) && !keptBeforeIds.has(sc.id)
              )
              return {
                count: back.length,
                seconds: back.reduce((t, sc) => t + (sc.end - sc.start), 0)
              }
            })(),
            content: plan.cut.spans.map((x) => ({ start: x.start, end: x.end }))
          }
        }
      }
      // 案A(今の設定)から順に作る。カットをやり直さないなら案は1つ(残し方が今のまま)
      const specs = rangedVariantSpecs(useSettingsStore.getState().editPolicy).filter((sp) =>
        how?.only ? sp.id === how.only : steps.cut || sp.id === 'A'
      )
      const canceled = {
        ok: false as const,
        canceled: true,
        reason: '止めました'
      }
      let previews: RangedPreview[] = []
      for (const spec of specs) {
        if (how?.signal?.aborted) return canceled
        // 前の案を画面に出してから次を作る(固まらないように)
        if (previews.length > 0) await new Promise((r) => setTimeout(r, 0))
        if (how?.signal?.aborted) return canceled
        const r = await makeOne(spec)
        if (how?.signal?.aborted) return canceled
        if (!r.ok) {
          // 案A が作れなければ(今の設定で作れない)理由を返す。ほかの案は出さないだけ
          if (spec.id === 'A') return r
          continue
        }
        previews = addRangedVariant(previews, r.preview)
        how?.onVariant?.(previews)
      }
      return { ok: true, previews }
    },
    applyRangedEdit: (preview, variants) => {
      if (get().running) return { ok: false, reason: '自動編集が動いている間は当てられません' }
      // 使った付け直しは、当てる時の一覧で決める(用意してから当てるまでに付け直した・外したものも)。
      // 当てると場面にクリップが戻り、付け直しの一覧から外れるので、当てる前に読む
      const usedNow = get().keepTouched.filter((id) => preview.sceneIds.includes(id))
      const roughCutBefore = get().roughCut
      // 同じ案をもう一度当てる(案を A → C → A と替えた)と、本編は前に当てた時と同じ並びになる。前の記録が
      // 残っていると、当てたのを「やり直し」と取り違え、範囲の記録を二重に足していた
      rangeApplied.delete(preview.after.clips)
      const ok = useProjectStore.getState().applyRangedProject(preview.after, preview.base)
      if (!ok) {
        log(
          '用意している間に編集画面で本編が直されたため、範囲の自動編集を当てませんでした(直したものはそのままです)'
        )
        return {
          ok: false,
          reason:
            '用意している間に本編が直されたため、当てませんでした。もう一度「この範囲を再編集」してください'
        }
      }
      // 残した場面の記録: 前の回(今の組んだ本編と同じ印)の残した場面のうち、範囲に丸ごと入る場面は
      // 今回の選び方に替え、範囲に掛かる場面は今回残したものを足す(今の本編から推し量らない)
      const prevKept = keptScenesOf(preview.base)
      const full = new Set(preview.fullScenes)
      const keptNow = new Set([
        ...prevKept.filter((id) => !full.has(id)),
        ...preview.keptIds.filter((id) => preview.sceneIds.includes(id))
      ])
      const keptIds = get()
        .scenes.map((sc) => sc.id)
        .filter((id) => keptNow.has(id))
      const applied = useProjectStore.getState().project
      if (usedNow.length > 0) usedTouches.set(preview.base.clips, usedNow)
      const used = new Set(usedNow)
      const run = { start: preview.window.start, end: preview.window.end, at: Date.now() }
      // 取り消し・やり直しで、範囲の自動編集の記録とイン点・アウト点(ルーラーの範囲)も行き来させる
      const entry = {
        run,
        baseClips: preview.base.clips,
        oldRange: preview.range,
        newRange: preview.newRange,
        roughCutBefore,
        roughCutAfter: roughCutBefore
      }
      rangeApplied.set(applied.clips, entry)
      set((s) => ({
        builtKept: builtKeptWith(s.builtKept, cutSignature(applied.roughCutAuto), keptIds),
        keepTouched: s.keepTouched.filter((id) => !used.has(id)),
        rangeRuns: [...s.rangeRuns, run].slice(-RANGE_RUNS_MAX),
        roughCut: s.roughCut
          ? {
              ...s.roughCut,
              keptIds,
              kept: keptIds.length,
              dropped: s.scenes.length - keptIds.length,
              duration: mainLength(applied),
              telops: applied.textOverlays.filter((o) => o.utteranceId).length
            }
          : s.roughCut,
        rangeReview: {
          beforeClips: preview.base.clips,
          afterClips: applied.clips,
          range: preview.newRange,
          oldRange: preview.range,
          summary: preview.summary,
          afterProject: applied,
          variants: variants && variants.length > 0 ? variants : [preview],
          current: preview.variant.id
        }
      }))
      entry.roughCutAfter = get().roughCut
      persistDecisions()
      const sm = preview.summary
      if (!quietApply)
        log(
          `範囲だけ自動編集しました: ${formatMinutes(sm.lengthBefore)} → ${formatMinutes(sm.lengthAfter)}・カット ${sm.cutsBefore} → ${sm.cutsAfter}・テロップ ${sm.telopsBefore} → ${sm.telopsAfter}${sm.movedHand > 0 ? `・後ろの手置き ${sm.movedHand} 個も動かしました` : ''}(取り消しは Ctrl+Z 1回)`
        )
      return { ok: true }
    },
    switchRangedVariant: (preview) => {
      if (useProjectStore.getState().trial)
        return { ok: false, reason: '試している間は替えられません(決めるか閉じてから)' }
      const review = get().rangeReview
      const ps = useProjectStore.getState()
      const variants = review?.variants ?? [preview]
      const project = ps.project
      if (review && project.clips === review.afterClips) {
        if (!sameExceptAutoEdit(project, review.afterProject))
          return {
            ok: false,
            reason: '当てた後に編集したため、案を替えませんでした(取り消してから替えてください)'
          }
        if (review.current === preview.variant.id) return { ok: true }
        // 当てた案を取り消してから別の案を当てる(履歴は1件のまま)
        ps.undo()
        const r = get().applyRangedEdit(preview, variants)
        if (!r.ok) {
          useProjectStore.getState().redo()
          return r
        }
        moveMarkedRange(preview.range, preview.newRange)
        return r
      }
      // 前(当てる前)を見ている、またはまだ当てていない
      const r = get().applyRangedEdit(preview, variants)
      if (r.ok) moveMarkedRange(preview.range, preview.newRange)
      return r
    },
    tryRangedVariant: (preview, variants) => {
      if (get().running) return { ok: false, reason: '自動編集が動いている間は当てられません' }
      // 試している案があれば、試す前に戻してから(履歴にも記録にも残さない)
      if (rangeTrial) revertRangeTrial()
      beginRangeTrial()
      quietApply = true
      let r: { ok: boolean; reason?: string }
      try {
        r = withTrialWrite(() => get().applyRangedEdit(preview, variants))
      } finally {
        quietApply = false
      }
      if (!r.ok) revertRangeTrial()
      return r
    },
    cancelRangedTrial: () => {
      if (rangeTrial) revertRangeTrial()
    },
    commitRangedVariant: (preview, variants) => {
      if (!rangeTrial || !useProjectStore.getState().trial) {
        rangeTrial = null
        return get().applyRangedEdit(preview, variants)
      }
      const rv = get().rangeReview
      const showing =
        rv &&
        rv.current === preview.variant.id &&
        useProjectStore.getState().project.clips === rv.afterClips
      if (!showing) {
        const r = get().tryRangedVariant(preview, variants)
        if (!r.ok) return r
      }
      rangeTrial = null
      useProjectStore.getState().endTrial(true)
      const sm = preview.summary
      log(
        `範囲だけ自動編集しました(案${preview.variant.id} ${preview.variant.label}): ${formatMinutes(sm.lengthBefore)} → ${formatMinutes(sm.lengthAfter)}・カット ${sm.cutsBefore} → ${sm.cutsAfter}(取り消しは Ctrl+Z 1回)`
      )
      return { ok: true }
    },
    setRangeRuns: (runs) => {
      set({ rangeRuns: runs })
      persistDecisions()
    },
    markReviewed: (key, reviewed) => useProjectStore.getState().setReviewed(key, reviewed)
  }
})

/** 当てた後の本編(クリップの並び)→ その範囲の自動編集(取り消し・やり直しで記録を行き来させる) */
const rangeApplied = new WeakMap<
  readonly unknown[],
  {
    run: RangeRun
    baseClips: readonly unknown[]
    oldRange: TimelineRange
    newRange: TimelineRange
    /** 当てる前・後の仮編集のまとめ(残した場面・長さ)。取り消し・やり直しで行き来させる */
    roughCutBefore: PipelineState['roughCut']
    roughCutAfter: PipelineState['roughCut']
  }
>()

/** 試しに当てている間(「試しに見る」)の、試す前の自動編集の記録 */
let rangeTrial:
  | (Pick<PipelineState, 'roughCut' | 'builtKept' | 'rangeRuns' | 'keepTouched' | 'rangeReview'> & {
      usedAtBase: string[] | undefined
      revived: Map<string, string[]>
      baseClips: readonly unknown[]
    })
  | null = null
/** 試しに当てるときは、当てたことを記録に書かない */
let quietApply = false

function beginRangeTrial(): void {
  const ps = useProjectStore.getState()
  if (ps.trial) return
  const s = usePipelineStore.getState()
  rangeTrial = {
    roughCut: s.roughCut,
    builtKept: s.builtKept,
    rangeRuns: s.rangeRuns,
    keepTouched: s.keepTouched,
    rangeReview: s.rangeReview,
    usedAtBase: usedTouches.get(ps.project.clips),
    revived: new Map(revivedFrom),
    baseClips: ps.project.clips
  }
  ps.beginTrial()
}

/** 試す前の企画・履歴・自動編集の記録に丸ごと戻す */
function revertRangeTrial(): void {
  const saved = rangeTrial
  const t = useProjectStore.getState().trial
  rangeTrial = null
  if (!t) return
  useProjectStore.getState().setIsPlaying(false)
  // 自動編集の記録を先に試す前へ戻す(企画を戻すときの購読が、試しの記録で判断を覚え直さないように)
  const restore = (): void => {
    if (!saved) return
    if (saved.usedAtBase) usedTouches.set(saved.baseClips, saved.usedAtBase)
    else usedTouches.delete(saved.baseClips)
    revivedFrom.clear()
    for (const [k, v] of saved.revived) revivedFrom.set(k, v)
    usePipelineStore.setState({
      roughCut: saved.roughCut,
      builtKept: saved.builtKept,
      rangeRuns: saved.rangeRuns,
      keepTouched: saved.keepTouched,
      rangeReview: saved.rangeReview
    })
  }
  restore()
  // 企画・履歴を試す前へ(裏で届いたプロキシ・検出は endTrial が引き継ぐ)
  useProjectStore.getState().endTrial(false)
  restore()
  // 戻す途中で自動編集の判断を覚え直していても、試す前の判断・未保存の印のまま
  const now = useProjectStore.getState().project
  useProjectStore.setState({
    project: now.autoEdit === t.project.autoEdit ? now : { ...now, autoEdit: t.project.autoEdit },
    isDirty: t.isDirty
  })
}

/**
 * 範囲の自動編集の取り消し・やり直しで戻す仮編集のまとめ。今のまとめが `from`(当てた時の写し)のままなら
 * `to` に戻す。当てた後に構成で判断を変えるなどして変わっていれば、今のまとめを基に、残した場面と長さ・
 * テロップの数だけを `to` と今の本編に合わせる(古い写しへ戻さない)
 */
function rebaseRoughCut(
  from: PipelineState['roughCut'],
  to: PipelineState['roughCut'],
  project: Project
): PipelineState['roughCut'] {
  const cur = usePipelineStore.getState().roughCut
  if (cur === from || !cur || !to) return to
  return {
    ...cur,
    keptIds: to.keptIds,
    kept: to.kept,
    dropped: to.dropped,
    duration: mainLength(project),
    telops: project.textOverlays.filter((o) => o.utteranceId).length
  }
}

/** イン点・アウト点・ルーラーの範囲が `from` を指していれば `to` へ移す */
function moveMarkedRange(from: TimelineRange, to: TimelineRange): void {
  const st = useProjectStore.getState()
  const same = (a: number | null | undefined, b: number): boolean =>
    a !== null && a !== undefined && Math.abs(a - b) < 1e-6
  if (same(st.timelineIn, from.start) && same(st.timelineOut, from.end)) {
    st.setTimelineIn(null)
    st.setTimelineOut(to.end)
    st.setTimelineIn(to.start)
  }
  if (st.dragRange && same(st.dragRange.start, from.start) && same(st.dragRange.end, from.end))
    st.setDragRange({ ...to })
}

// 範囲の自動編集を取り消したら記録(全体の作り直しの前の確認に使う)を外し、やり直したら戻す。
// 当てた後に動かしたイン点・アウト点・ルーラーの範囲も一緒に戻す
useProjectStore.subscribe((state, prev) => {
  if (state.project.clips === prev.project.clips) return
  const undone = rangeApplied.get(prev.project.clips)
  if (undone && undone.baseClips === state.project.clips) {
    const runs = usePipelineStore.getState().rangeRuns
    // 仮編集のまとめ(残した場面・長さ)も当てる前に戻す
    usePipelineStore.setState({
      roughCut: rebaseRoughCut(undone.roughCutAfter, undone.roughCutBefore, state.project)
    })
    usePipelineStore.getState().setRangeRuns(runs.filter((r) => r !== undone.run))
    moveMarkedRange(undone.newRange, undone.oldRange)
  }
  const redone = rangeApplied.get(state.project.clips)
  if (redone && redone.baseClips === prev.project.clips) {
    const runs = usePipelineStore.getState().rangeRuns
    usePipelineStore.setState({
      roughCut: rebaseRoughCut(redone.roughCutBefore, redone.roughCutAfter, state.project)
    })
    usePipelineStore
      .getState()
      .setRangeRuns(runs.includes(redone.run) ? runs : [...runs, redone.run].slice(-RANGE_RUNS_MAX))
    moveMarkedRange(redone.oldRange, redone.newRange)
  }
})

/** 本編の修正を重ねる(重ならない窓の内と外を合わせる) */
function mergeOverrideParts(
  a: CutOverrides | undefined,
  b: CutOverrides | undefined
): CutOverrides | undefined {
  if (!a) return b
  if (!b) return a
  return {
    removed: [...a.removed, ...b.removed].sort((x, y) => x.start - y.start),
    added: [...a.added, ...b.added].sort((x, y) => x.start - y.start),
    angles: [...a.angles, ...b.angles].sort((x, y) => x.start - y.start)
  }
}

/** 自動編集で触らない範囲の、作り直す前と後のタイムラインの区間と、作り直す前の企画 */
interface LockedSounds {
  windows: { prev: TimelineRange; now: TimelineRange }[]
  prev: Project
}

/** ロックの窓(共通の時刻)の、作り直す前と後の本編での区間 */
function lockedSoundWindows(
  prev: Project,
  applied: Project,
  locks: readonly Range[]
): LockedSounds | undefined {
  const info = applied.multicam
  const prevInfo = prev.multicam
  if (!info || !prevInfo) return undefined
  // 塊ごと(離れた所に差し戻した複製も、その塊の置かれた所へずらす)
  const windows = locks.flatMap((l) =>
    matchLockBlocks(prev.clips, applied.clips, info, l).map((w) => ({
      prev: { start: w.prev.start, end: w.prev.end },
      now: w.now
    }))
  )
  return windows.length > 0 ? { windows, prev } : undefined
}

/** ロックの境で切った自動の BGM に付けるフェード(秒) */
const LOCK_EDGE_FADE = 0.5

const startsWithin = (t: number, r: TimelineRange): boolean =>
  t >= r.start - 1e-6 && t < r.end - 1e-6

/** 音を区間 `r` の中だけ(`inside`)か外だけにする。切った所に短いフェード */
function clipSoundTo(x: PlacedSound, r: TimelineRange, inside: boolean): PlacedSound[] {
  const end = x.startTime + (x.outPoint - x.inPoint)
  const piece = (a: number, b: number, fadeHead: boolean, fadeTail: boolean): PlacedSound[] => {
    if (b - a <= 1e-3) return []
    const len = b - a
    const fadeIn = fadeHead
      ? Math.min(LOCK_EDGE_FADE, len / 3)
      : a === x.startTime
        ? x.fadeIn
        : undefined
    const fadeOut = fadeTail ? Math.min(LOCK_EDGE_FADE, len / 3) : b === end ? x.fadeOut : undefined
    return [
      {
        ...x,
        startTime: a,
        inPoint: x.inPoint + (a - x.startTime),
        outPoint: x.inPoint + (b - x.startTime),
        fadeIn,
        fadeOut
      }
    ]
  }
  if (inside) {
    const a = Math.max(x.startTime, r.start)
    const b = Math.min(end, r.end)
    return piece(a, b, a > x.startTime + 1e-6, b < end - 1e-6)
  }
  if (end <= r.start + 1e-6 || x.startTime >= r.end - 1e-6) return [x]
  return [
    ...piece(x.startTime, Math.min(end, r.start), false, true),
    ...piece(Math.max(x.startTime, r.end), end, true, false)
  ]
}

/** 置く音のうち、ロックの所のものを、作り直す前の自動の音に替える(BGM は境で切ってフェード) */
function keepLockedSounds(
  planned: PlacedSound[],
  locked: LockedSounds,
  role: 'se' | 'bgm'
): PlacedSound[] {
  const track = locked.prev.audioTracks.find((t) => t.autoRole === role && isUntouchedAuto(t))
  const pathOf = new Map(locked.prev.assets.map((a) => [a.id, a.filePath]))
  let out = [...planned]
  for (const w of locked.windows) {
    const shift = w.now.start - w.prev.start
    const prevIn: PlacedSound[] = (track?.clips ?? []).flatMap((c) => {
      const path = pathOf.get(c.assetId)
      if (!path) return []
      const sound: PlacedSound = {
        path,
        startTime: c.startTime,
        inPoint: c.inPoint,
        outPoint: c.outPoint,
        volume: c.volume ?? 1,
        ...(c.fadeIn ? { fadeIn: c.fadeIn } : {}),
        ...(c.fadeOut ? { fadeOut: c.fadeOut } : {}),
        reason: '自動編集で触らない範囲'
      }
      if (role === 'se') return startsWithin(c.startTime, w.prev) ? [sound] : []
      return clipSoundTo(sound, w.prev, true)
    })
    out =
      role === 'se'
        ? out.filter((x) => !startsWithin(x.startTime, w.now))
        : out.flatMap((x) => clipSoundTo(x, w.now, false))
    out.push(...prevIn.map((x) => ({ ...x, startTime: x.startTime + shift })))
  }
  return out.sort((a, b) => a.startTime - b.startTime)
}

/** 置く CG のうち、ロックの所のものを、作り直す前の自動の CG に替える */
function keepLockedCg(planned: PlacedCg[], locked: LockedSounds): PlacedCg[] {
  const track = locked.prev.videoOverlayTracks.find(
    (t) => t.autoRole === 'cg' && isUntouchedAuto(t)
  )
  const pathOf = new Map(locked.prev.assets.map((a) => [a.id, a.filePath]))
  let out = [...planned]
  for (const w of locked.windows) {
    const shift = w.now.start - w.prev.start
    out = out.filter((x) => !startsWithin(x.startTime, w.now))
    for (const c of track?.clips ?? []) {
      const path = pathOf.get(c.assetId)
      if (!path || !startsWithin(c.startTime, w.prev)) continue
      out.push({
        path,
        startTime: c.startTime + shift,
        inPoint: c.inPoint,
        outPoint: c.outPoint,
        keyword: ''
      })
    }
  }
  return out.sort((a, b) => a.startTime - b.startTime)
}

/** 番組素材フォルダの素材を読み込む(企画にすでにあるファイルは読まない。読めないものは飛ばす) */
async function loadKitAssets(allPaths: readonly string[]): Promise<MediaAsset[]> {
  const have = new Set(useProjectStore.getState().project.assets.map((a) => a.filePath))
  const paths = [...new Set(allPaths)].filter((p) => !have.has(p))
  const assets: MediaAsset[] = []
  for (const path of paths) {
    if (isImagePath(path)) {
      // 読めない画像(動く画像・壊れた画像)は置かない
      const still = await stillAssetFrom(path).catch(() => null)
      if (still) assets.push(still)
      continue
    }
    const meta = await window.api.probeMedia(path).catch(() => null)
    if (!meta) continue
    assets.push({
      id: uuid(),
      filePath: path,
      fileName: path.split(/[/\\]/).pop() ?? path,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      hasAudio: meta.hasAudio,
      hasVideo: meta.hasVideo
    })
  }
  return assets
}

/** 仮編集のタイムラインの時刻で持っているテロップを、今の本編の時刻へ写す(本編から消えた所のものは捨てる) */
function mapTelopsToTimeline<
  T extends { startTime: number; endTime: number; words?: { start: number; end: number }[] }
>(telops: readonly T[], from: RoughCut['spans'], to: RoughCut['spans']): T[] {
  const segs = timelineMapping(from, to)
  return telops.flatMap((o) => {
    const pieces = mapTimelineRange(segs, o.startTime, o.endTime)
    if (pieces.length === 0) return []
    const start = pieces[0].at
    const last = pieces[pieces.length - 1]
    const shift = start - o.startTime
    return [
      {
        ...o,
        startTime: start,
        endTime: Math.max(start + 0.1, last.at + (last.to - last.from)),
        // カラオケの単語の時刻も一緒に動かす
        ...(o.words
          ? { words: o.words.map((w) => ({ ...w, start: w.start + shift, end: w.end + shift })) }
          : {})
      }
    ]
  })
}

/** 作り直しの回の残した場面を足す(同じ組んだ本編の印の古いものは除き、新しいものを後ろへ) */
function builtKeptWith(
  list: readonly { cut: string; keptIds: string[] }[],
  cut: string | undefined,
  keptIds: readonly string[]
): { cut: string; keptIds: string[] }[] {
  if (!cut) return [...list]
  return [...list.filter((b) => b.cut !== cut), { cut, keptIds: [...keptIds] }].slice(
    -BUILT_KEPT_MAX
  )
}

/** チェックを触った順の番号(作り直しの間に触ったものを、作り直しの最後に消さないため) */
let keepTouchClock = 0
const keepTouchedAt = new Map<string, number>()
/**
 * 作り直しの前の本編(クリップの並び)→ その作り直しで使った付け直し。取り消し(Ctrl+Z)でその本編に
 * 戻ったら、付け直しはまだ使っていないことにする(自動編集の判断は取り消しで戻らないので)。
 * 同じ並びを手で作り直しても別の配列なので当たらない(付け直さなければ戻さない)
 */
/** 当たった作り直しの数(場面の切り直しが当たったかを見る) */
let appliedBuilds = 0
let usedTouches = new WeakMap<readonly unknown[], string[]>()
/**
 * 取り消しで付け直しを戻した時の本編(取り消す前の並び)→ 戻した付け直しと、戻した時のチェックの番号。
 * やり直し(Ctrl+Y)でその並びに来たら、戻した付け直しを使い済みに戻す(その後に触り直したものは除く)
 */
let revivedTouches = new WeakMap<readonly unknown[], { ids: string[]; clock: number }>()
/** 今の本編にクリップを持つ場面(クリップの場面は `sceneOfSpan`) */
function ownedScenes(
  project: Project,
  scenes: readonly { id: string; start: number; end: number }[]
): Set<string | undefined> {
  return new Set(
    project.multicam
      ? coverageOfClips(project.clips, project.multicam).map((c) => sceneOfSpan(scenes, c))
      : scenes.map((sc) => sc.id)
  )
}

/**
 * 取り消しで戻した付け直し → 戻した元の記録(`usedTouches` の中身)。戻した付け直しが、場面に本編の
 * クリップが戻って捨てられたら、元の記録からも外す(やり直しでまた戻さない。消したのを取り消したのと同じ)
 */
const revivedFrom = new Map<string, string[]>()

/** 場面を切り直したら、前の場面の ID の記録は使わない(別の場面に付く。戻さない側に倒す) */
function forgetUsedTouches(): void {
  usedTouches = new WeakMap()
  revivedTouches = new WeakMap()
  revivedFrom.clear()
}

/** 残した場面の ID を、切り直した場面の ID へ移す(時刻がほぼ同じ場面だけ。`match` は今 → 前) */
function remapKept(ids: readonly string[], match: ReadonlyMap<string, string>): string[] {
  const set = new Set(ids)
  return [...match].filter(([, prev]) => set.has(prev)).map(([id]) => id)
}

/** 同期の報告から、企画に覚える要約を作る(素材ごとの位置の決め方は、企画の素材の ID で) */
function syncSummaryOf(report: SyncReport, project: Project): SyncSummary {
  const drift = report.pairs
    .map((p) => p.driftPpm)
    .filter((v): v is number => v !== undefined && Number.isFinite(v))
  const methodOf = new Map(report.placements.map((p) => [p.id, p.method]))
  const methods: Record<string, PlacementMethod> = {}
  for (const f of project.multicam?.files ?? []) {
    const a = project.assets.find((x) => x.id === f.assetId)
    const m = a && (methodOf.get(a.denoisedFrom ?? a.filePath) ?? methodOf.get(a.filePath))
    if (m) methods[f.assetId] = m
  }
  return {
    placed: report.placements.filter((p) => p.method !== 'none').length,
    total: report.placements.length,
    reliablePairs: report.pairs.filter((p) => p.reliable).length,
    pairs: report.pairs.length,
    ...(drift.length > 0 ? { maxDriftPpm: Math.max(...drift.map(Math.abs)) } : {}),
    elapsedMs: report.elapsedMs,
    ...(Object.keys(methods).length > 0 ? { methods } : {})
  }
}

/** AI に頼んで決まる演出テロップの ID(自動で決まる種類は、作り直しのたびに同じ ID で作り直す) */
const AUTO_EFFECT_ID = /^(laugh|chapter|clock|bubble|name)-/

/** タイムラインの時刻 = 共通の時刻 の対応(演出テロップを共通の時刻で覚えるのに使う) */
const COMMON_TIME: RoughCut['spans'] = [{ timeline: -1e7, start: -1e7, end: 1e7 }]

/**
 * 作り直しで、今置いてある演出テロップのうち提案の一覧に無いものを、新しい仮編集の位置へ写したもの
 * (`placed`)。人が直したものは必ず写す。直していない AI の提案は、新しい AI の提案が無いときだけ写す
 * (古い形式の企画・AI を使わない設定・AI が失敗した)。人が消したものは写さない。
 * 人が直したものは共通の時刻で覚えておき(`remember`)、場面を落として本編から消えても、場面を戻したら
 * 置き直す(今のタイムラインにあるものしか写さないと、一度落とした場面のものは二度と戻らなかった)
 */
function carriedEffectTelops(
  project: Project,
  proposals: readonly EffectProposal[],
  freshAi: boolean,
  to: RoughCut['spans'],
  remembered: readonly Omit<TextOverlay, 'id'>[]
): { placed: Omit<TextOverlay, 'id'>[]; remember: Omit<TextOverlay, 'id'>[] } {
  const info = project.multicam
  if (!info || project.clips.length === 0) return { placed: [], remember: [...remembered] }
  const listed = new Set(proposals.map((p) => p.id))
  const dismissed = new Set(project.dismissedTelops ?? [])
  const usable = (o: { effectId?: string }): boolean =>
    Boolean(o.effectId) && !listed.has(o.effectId!) && !dismissed.has(`e:${o.effectId}`)
  const carry = project.textOverlays.filter(
    (o) => usable(o) && (o.edited || (!freshAi && !AUTO_EFFECT_ID.test(o.effectId!)))
  )
  const current = spansOfClips(project.clips, info)
  const onTimeline = new Set(project.textOverlays.map((o) => o.effectId).filter(Boolean))
  // 覚えているもののうち、場面を落として本編から消えたもの(今の本編に時刻が無い)。
  // 本編にある所で見当たらないもの(取り消した・別の操作で外れた)は戻さない
  const lost = remembered.filter(
    (o) =>
      usable(o) &&
      !onTimeline.has(o.effectId) &&
      mapTelopsToTimeline([o], COMMON_TIME, current).length === 0
  )
  const placed = [
    ...mapTelopsToTimeline(
      carry.map((o) => omitId(o)),
      current,
      to
    ),
    ...mapTelopsToTimeline(lost, COMMON_TIME, to)
  ]
  const remember = [
    ...mapTelopsToTimeline(
      carry.filter((o) => o.edited).map((o) => omitId(o)),
      current,
      COMMON_TIME
    ),
    ...lost
  ]
  return { placed, remember }
}

function omitId(o: TextOverlay): Omit<TextOverlay, 'id'> {
  const rest: Partial<TextOverlay> = { ...o }
  delete rest.id
  return rest as Omit<TextOverlay, 'id'>
}

/** 吹き出しを選んだ発言(発言テロップの代わりに吹き出しで出す) */
function bubbledUtterances(
  effects: readonly EffectProposal[],
  chosen: readonly string[],
  dismissed: readonly string[] = []
): Set<string> {
  const set = new Set(chosen)
  // 人が吹き出しを消したなら、発言テロップを戻す(消したままだと、その発言の文字がどこにも出ない)
  const gone = new Set(dismissed)
  return new Set(
    effects
      .filter((e) => e.kind === 'bubble' && set.has(e.id) && !gone.has(`e:${e.id}`))
      .map((e) => e.afterLineId)
  )
}

/**
 * Unix 時刻を ms にそろえる。前の版は秒のまま企画に保存していたので、ms としては小さすぎる値
 * (1e11 ms = 1973年より前)は秒とみなす
 */
export function epochMs(t: number): number {
  return Math.abs(t) < 1e11 ? t * 1000 : t
}

/**
 * 素材ごとの撮影開始時刻(ms)。同期した素材の一覧(この起動で読んだもの)か、
 * 企画に覚えた値(開き直したとき)から取る
 */
export function recordedAtByAsset(
  project: Project,
  synced: readonly SyncInputFile[]
): Map<string, number> {
  const out = new Map<string, number>()
  for (const f of project.multicam?.files ?? [])
    if (typeof f.recordedAt === 'number' && Number.isFinite(f.recordedAt))
      out.set(f.assetId, epochMs(f.recordedAt))
  // 素材の記録から読んだ時刻は秒(`recordedAtFromTags`)。ms にそろえる
  // (秒のまま足していたので、時刻スーパーが 1970年1月1日の時刻「PM 4:54」になっていた)
  const byPath = new Map(
    synced
      .filter((f) => f.recordedAt !== undefined && Number.isFinite(f.recordedAt))
      .map((f) => [f.path, epochMs(f.recordedAt!)])
  )
  for (const a of project.assets) {
    const t = byPath.get(a.denoisedFrom ?? a.filePath) ?? byPath.get(a.filePath)
    if (t !== undefined) out.set(a.id, t)
  }
  return out
}

// 取り消し(Ctrl+Z)で、付け直しを使った作り直しの前の本編に戻ったら、付け直しをまだ使っていないことに
// する(自動編集の判断は取り消しで戻らないので、ここで戻す。企画にも覚え、保存して開き直しても効く)
// やり直し(Ctrl+Y)で作り直しの後の本編に戻ったら、戻した付け直しをまた使い済みにする
useProjectStore.subscribe((state, prev) => {
  if (state.project.clips === prev.project.clips) return
  const pending = usePipelineStore.getState().keepTouched
  let keepTouched = pending
  const used = usedTouches.get(state.project.clips)
  if (used) {
    const scenes = new Set(usePipelineStore.getState().scenes.map((sc) => sc.id))
    const linked = used.filter((id) => scenes.has(id))
    const back = linked.filter((id) => !pending.includes(id))
    // 既に付け直してあった場面も、元の記録と結び付ける(後で場面にクリップが戻って捨てたら、元の
    // 記録からも外す。外さないと、やり直しでまた戻る)
    for (const id of linked) revivedFrom.set(id, used)
    if (linked.length > 0)
      revivedTouches.set(prev.project.clips, { ids: back, clock: keepTouchClock })
    if (back.length > 0) keepTouched = [...pending, ...back]
  }
  const revived = revivedTouches.get(state.project.clips)
  if (keepTouched === pending && revived) {
    const drop = new Set(revived.ids.filter((id) => (keepTouchedAt.get(id) ?? 0) <= revived.clock))
    keepTouched = pending.filter((id) => !drop.has(id))
    for (const id of drop) revivedFrom.delete(id)
  }
  // 付け直しは丸ごと消した場面のもの。場面に本編のクリップが戻ったら(消したのを取り消した など)、
  // その付け直しはもう使わない(また消しても、付け直さなければ戻さない)
  if (keepTouched.length > 0) {
    const owned = ownedScenes(state.project, usePipelineStore.getState().scenes)
    for (const id of keepTouched.filter((x) => owned.has(x))) {
      // やり直しで、その付け直しを使った作り直しの後の本編に来た(使い済みに戻る所)なら、元の記録は
      // 残す(また取り消せば戻す)
      const from = revived?.ids.includes(id) ? undefined : revivedFrom.get(id)
      if (from?.includes(id)) from.splice(from.indexOf(id), 1)
      revivedFrom.delete(id)
    }
    keepTouched = keepTouched.filter((id) => !owned.has(id))
  }
  if (keepTouched.length === pending.length && keepTouched.every((id, k) => id === pending[k]))
    return
  usePipelineStore.setState({ keepTouched })
  const autoEdit = state.project.autoEdit
  if (autoEdit) {
    // 形は persistDecisions とそろえる(空なら書かない)
    const { keepTouched: _old, ...rest } = autoEdit
    void _old
    useProjectStore.getState().setAutoEdit(keepTouched.length > 0 ? { ...rest, keepTouched } : rest)
  }
})

// 別のプロジェクトを開いた・新しく作ったら、前の回の自動編集の結果を捨てる
// (残すと「仮編集を作り直す」が前の回の場面の区切りで今の回を切り、要確認にも前の回の項目が出る)
onProjectSwitch((switchKind) => {
  const pipeline = usePipelineStore.getState()
  // 試しに当てていた企画からは離れた(企画の側の試しは切り替えで消える)
  rangeTrial = null
  // 自動編集の途中で「開く / 新規 / 自動保存を復元」すると、resetResults だけでは
  // 既に走っている main 側の同期・ASR・イベント検出が生き残る。完了後にその古い結果が
  // 新しいプロジェクトへ書き込まれるため、切替時はまず処理を中止する。
  if (pipeline.running) pipeline.cancel()
  pipeline.resetResults()
  // 仕上がりの長さ・方針は企画ごと。前の企画のものは持ち越さない(開いた企画に覚えていれば、読み直すときに戻す)
  usePipelineStore.setState({ targetMinutes: 0, editNote: '' })
  // 別の企画を開いたら、前の回の収録フォルダの読み取り(素材の整理・同期にかけた素材)も捨てる。
  // 残すと、開いた企画の取り込みの欄と食い違う(タブに前の回のカメラが並ぶ)。
  // 新しい回では残す(「新しい回を作る」で読んだフォルダを、作った企画で使う)
  if (switchKind === 'open') pipeline.dropScan()
  // 開いた企画は、知らせの後に入る。入ってから、企画に残っている結果で画面を作り直す
  queueMicrotask(() => usePipelineStore.getState().restoreFromProject())
})

// 自動編集の最中は、PC をスリープさせず、タスクバーに進み具合を出す。終わったら知らせる
// 走り出したときの各工程の状態。作り直しでは前の通しの失敗が残っているので、
// この回に新しく止まった工程だけを知らせる
let stepsAtStart: Record<StepId, StepStatus> | null = null
/** 自動編集の「中止」を押したか(工程の間で確かめて、先の工程へ進まない) */
let runCanceled = false
/** 工程の結果を捨てるたびに増やす(捨てた後に、前の実行の印を書かない) */
let runGeneration = 0
function stopIfCanceled(): void {
  if (runCanceled) throw new Error('PIPELINE_CANCELED')
}
/** 中止を押した、または中止で止まった処理の知らせか */
function isCanceled(message: string): boolean {
  return runCanceled || /ASR_CANCELED|LLM_CANCELED|DENOISE_CANCELED|PIPELINE_CANCELED/.test(message)
}
/** 仮編集の作り直しで動く工程(中止・失敗したとき、動いていたものを探す順) */
const REBUILD_STEPS: StepId[] = ['effects', 'sound', 'timeline', 'cut', 'angles', 'placement']
/** 通話のトラックの声のうち、1人ずつのマイクに入っている割合がこれ以上なら、同じ声とみなす */
const SAME_VOICE_COVERAGE = 0.7
/** 別に録ったマイクの人が話している所の前後、全部入りを話者の判定に使わない幅(秒) */
const MIX_MASK_PAD_SEC = 0.2
/**
 * 全部入りの残り(配信者の声)の発言の話者名。全部入りに人が名前を付けていればその名前、
 * 自動の名前(「全部入り(トラック1)」)のままなら「配信者」
 */
function streamerName(sourceName: string | undefined): string {
  return sourceName && !AUTO_TRACK_NAME.test(sourceName) ? sourceName : STREAMER_SPEAKER
}
/** 収録フォルダを読むたびに増やす(古い読み込みの結果を捨てるため) */
let scanToken = 0
usePipelineStore.subscribe((s, prev) => {
  if (s.running && !prev.running) stepsAtStart = s.steps
  if (s.running) {
    const current = STEPS.find((st) => s.steps[st.id].state === 'run')
    reportBusy('pipeline', {
      label: `自動編集${current ? `(${current.label})` : ''}`,
      percent: overallPercent(STEPS.map((st) => s.steps[st.id]))
    })
  } else if (prev.running) {
    reportBusy('pipeline', null)
    const before = stepsAtStart
    stepsAtStart = null
    // 人が中止したときは知らせない(「終わりました」と出すと誤解する)
    const changed = STEPS.filter((st) => s.steps[st.id] !== before?.[st.id])
    if (runCanceled || changed.some((st) => s.steps[st.id].note === '中止しました')) return
    const failed = changed.filter((st) => s.steps[st.id].state === 'error')
    if (failed.length > 0)
      window.api.notifyDone(
        '自動編集で止まった工程があります',
        failed.map((st) => `${st.label}: ${s.steps[st.id].note ?? ''}`).join('\n')
      )
    else
      window.api.notifyDone(
        '自動編集が終わりました',
        `${useProjectStore.getState().project.name} — 仕上がりを確かめて、要確認の項目を見てください`
      )
  }
})

/**
 * 取り出した音声トラックの位置を、元の動画の位置にする(同じ時計・同じ頭)。
 * 元の動画が同期できなければ、トラックも同期できなかった扱い
 */
/**
 * 取り出した音声トラック → 置き場所を借りる素材(同じ動画の時計を持つもの)。
 * 元の動画を同期するなら元の動画から。元の動画を「使わない」にしたなら、同じ動画のトラックのうち
 * 1本(声 → 全部入り → ゲーム音の順)だけを照らし合わせ、残りはそれに揃える
 * (ゲーム音だけのトラックは声の素材と似ておらず、1本ずつ照らし合わせると外れたり、ずれたりする)
 */
export function trackParentMap(
  sources: readonly Pick<EditableSource, 'files' | 'trackRole'>[],
  inSync: ReadonlySet<string>
): Map<string, string> {
  const parentOf = new Map<string, string>()
  const orphans = new Map<string, { path: string; role?: string }[]>()
  for (const s of sources)
    for (const f of s.files) {
      if (!f.track) continue
      const parent = f.track.parentPath
      if (inSync.has(parent)) parentOf.set(f.path, parent)
      else
        orphans.set(parent, [...(orphans.get(parent) ?? []), { path: f.path, role: s.trackRole }])
    }
  const rank = (r?: string): number => (r === 'voice' ? 0 : r === 'mix' ? 1 : r === 'call' ? 2 : 3)
  for (const group of orphans.values()) {
    const lead = [...group].sort((a, b) => rank(a.role) - rank(b.role))[0]
    for (const g of group) if (g !== lead) parentOf.set(g.path, lead.path)
  }
  return parentOf
}

export function withTrackPlacements(
  report: SyncReport,
  files: readonly SyncInputFile[],
  parentOf: ReadonlyMap<string, string>
): SyncReport {
  const byId = new Map(report.placements.map((p) => [p.id, p]))
  const extra = files
    .filter((f) => parentOf.has(f.path))
    .map((f) => {
      const parent = byId.get(parentOf.get(f.path)!)
      return parent
        ? { ...parent, id: f.id }
        : { id: f.id, start: 0, rate: 1, method: 'none' as const }
    })
  return { ...report, placements: [...report.placements, ...extra] }
}

export interface ShortsProgress {
  state: 'idle' | 'run' | 'done' | 'error'
  done: number
  total: number
  /** 書いた動画のパス */
  files: string[]
  note?: string
}

function clockText(sec: number): string {
  const t = Math.max(0, Math.round(sec))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

/** 構成の工程の欄の文(場面・見どころ・不要の数と、判定のしかた) */
function structureNote(
  judgements: readonly SceneJudgement[],
  source: 'ai' | 'heuristic' | null,
  demoted: boolean
): string {
  const highlights = judgements.filter((j) => j.kind === 'highlight').length
  const unneeded = judgements.filter((j) => j.kind === 'unneeded').length
  return `場面 ${judgements.length} · 見どころ ${highlights}${demoted ? '(点数で選び直し)' : ''} · 不要 ${unneeded}${source === 'ai' ? ' · AI' : ' · 簡易'}`
}

/** 動画から取り出したトラックの音源なら、元の動画を持つ音源(カメラ)の ID */
function trackParentSource(s: EditableSource, all: readonly EditableSource[]): string | undefined {
  const parent = s.files.find((f) => f.track)?.track?.parentPath
  if (!parent) return undefined
  return all.find((x) => x.files.some((f) => f.path === parent))?.id
}

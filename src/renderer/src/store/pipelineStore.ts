import { speechLook } from '@shared/telop/styles'
import type { HypeMoment } from '@shared/structure/hype'
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
  updateOverrides
} from '@shared/roughCut/overrides'
import { planCg } from '@shared/finish/cg'
import {
  fallbackMood,
  planBgm,
  planSoundEffects,
  timelineRangeOf,
  type BgmMood
} from '@shared/finish/sound'
import { planCameraColors } from '../lib/colorMatchPlan'
import { COLOR_VERDICT_TEXT, describeColorMatch, type ColorMatchVerdict } from '@shared/color/match'
import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { FootageScan, FootageSource, ProbedFile, SourceKind } from '@shared/ingest/classify'
import type { SyncInputFile, SyncReport } from '@shared/sync/report'
import { buildMulticamLayout } from '@shared/sync/multicamLayout'
import type { MediaAsset } from '@shared/types'
import { onProjectSwitch, useProjectStore } from './projectStore'
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
  peakSpans
} from '../lib/roughCutPlan'
import { placeTelopsAvoidingFaces, placeTelopsAvoidingHud } from '../lib/telopPlacement'
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
  isLikelyHallucination,
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
        mics.length > 0
          ? `発話 ${turns.length} · 重なり ${overlapCount}`
          : `発話 ${turns.length} · ピンマイクが無いため話者は未判定`
    })
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
    const off = window.api.onAsrProgress((m) => {
      if (m.type === 'status') setStep('transcribe', { percent: m.percent, note: m.note })
      else if (m.type === 'device') {
        set({ asrDevice: m.device })
        log(
          `音声認識: ${m.device === 'cpu' ? 'CPU' : `GPU(${m.device === 'dml' ? 'DirectML' : 'CUDA'})`}`
        )
        if (m.note) log(m.note)
      } else if (m.type === 'progress') {
        const left =
          m.done > 0 ? (((Date.now() - t0) / m.done) * (m.total - m.done)) / 1000 : undefined
        setStep('transcribe', {
          percent: (m.done / Math.max(1, m.total)) * 100,
          note: `${m.done}/${m.total}${left !== undefined ? ` · 残り約 ${Math.ceil(left / 60)} 分` : ''}`
        })
      }
    })
    let results: AsrJobResult[]
    try {
      results = await window.api.asrRun(jobs.map((j) => j.job))
    } finally {
      off()
    }
    const byId = new Map(results.map((r) => [r.id, r]))
    const nameOf = new Map(used.map((s) => [s.id, s.name]))
    const utterances: TranscriptUtterance[] = []
    for (const j of jobs) {
      const r = byId.get(j.job.id)
      if (!r || isLikelyHallucination(r.text)) continue
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
    useProjectStore.getState().setTranscript(utterances)
    setStep('transcribe', {
      state: 'done',
      percent: 100,
      note: `${utterances.length} 件 · ${Math.round((Date.now() - t0) / 1000)} 秒`
    })
    log(`文字起こしが終わりました(${utterances.length} 件)`)
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
      useProjectStore.getState().setAssetsDenoised(changes, {
        expectFilePath: Object.fromEntries(assets.map((a) => [a.id, a.filePath]))
      })
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
    allTelops: Omit<TextOverlay, 'id'>[]
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
      const se = planSoundEffects(
        // 本編の終わりより後(人が演出テロップを動かした など)に SE は置かない
        effects.filter((e) => e.time < duration),
        scenes.map((x) => x.start),
        kit,
        style ? { perMinute: style.sePerMinute, durationSec: duration } : undefined
      )
      const bgm = planBgm(scenes, kit, style?.bgmVolume)
      const cg = planCg(allTelops, kit.cg)
      // 置く素材を読み込む(すでにあるものは使い回す)
      const have = new Set(useProjectStore.getState().project.assets.map((a) => a.filePath))
      const paths = [...new Set([...se, ...bgm, ...cg].map((x) => x.path))].filter(
        (p) => !have.has(p)
      )
      const assets: MediaAsset[] = []
      for (const path of paths) {
        if (isImagePath(path)) {
          assets.push(await stillAssetFrom(path))
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
      hype: hype ?? []
    })
    setStep('structure', {
      state: 'done',
      percent: 100,
      note: structureNote(judgements, source, false)
    })
    log(
      source === 'ai'
        ? `構成: AI(${model ?? ''}${device ? `・${device === 'cpu' ? 'CPU' : `GPU ${device.toUpperCase()}`}` : ''})で ${scenes.length} 場面を判定しました`
        : failure
          ? `構成: AI に頼めなかったため簡易の点数で判定しました(${failure})`
          : '構成: AI を使わない設定のため、簡易の点数(発話の密度・掛け合い・盛り上がり)で判定しました'
    )
    await buildAndApply()
  }

  async function buildAndApply(): Promise<void> {
    const project = useProjectStore.getState().project
    const info = project.multicam
    if (!info) return
    setStep('cut', { state: 'run', percent: 0, note: '音の大きさを読み込み中' })
    const activity = await activityOf(project, info)
    // 前に組んだ本編と今の本編を比べ、人が削った・足した区間、替えたカメラを読み取る
    const overrides = releaseOverridesForScenes(
      project.roughCutAuto
        ? updateOverrides(
            project.cutOverrides,
            project.roughCutAuto,
            coverageOfClips(project.clips, info)
          )
        : project.cutOverrides,
      get().scenes,
      get().keep
    )
    const plan = planRoughCut(project, info, get().scenes, get().judgements, activity, {
      overrides,
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
      setStep('cut', {
        state: 'error',
        note: '残す場面がありません(構成で残す場面を選ぶか、「大事にすること」を替えてください)'
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
    if (plan.selection.relaxed)
      log('声の山・笑いのはっきりした場面が無かったため、点数の上位の場面を残しました(静かな回)')
    const raw = plan.selection.kept.reduce((t, id) => {
      const sc = get().scenes.find((x) => x.id === id)
      return t + (sc ? sc.end - sc.start : 0)
    }, 0)
    setStep('cut', {
      state: 'done',
      percent: 100,
      note: `${plan.pieces.length} 区間 · 間を詰めて ${formatMinutes(raw)} → ${formatMinutes(plan.cut.duration)}`
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
      const chooseFrom = (list: readonly EffectProposal[]): string[] =>
        list
          .filter((p) =>
            prevIds.has(p.id) ? prevChosen.has(p.id) : p.confidence >= AUTO_PLACE_CONFIDENCE
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
    set({ lastSpans: plan.cut.spans, speechTelops: telops })
    useProjectStore
      .getState()
      .applyRoughCut(
        plan.cut,
        [...telops.filter((o) => !o.utteranceId || !bubbled.has(o.utteranceId)), ...effectTelops],
        overrides
      )
    if (hasOverrides(overrides))
      log(
        `本編の手直しを当て直しました(削った区間 ${overrides!.removed.length}・足した区間 ${overrides!.added.length}・替えたカメラ ${overrides!.angles.length})`
      )
    set({
      roughCut: {
        keptIds: plan.selection.kept,
        kept: plan.selection.kept.length,
        dropped: plan.selection.dropped.length,
        duration: plan.cut.duration,
        shots: switches,
        telops: telops.length
      }
    })
    // SE・BGM・CG は、仮編集を当てた後の本編(人が差し込んだクリップ・削った区間を含む)の時刻で置く。
    // 組んだだけの仮編集の時刻で置くと、差し込んだクリップの後ろが差し込んだ長さぶん早くずれる
    const applied = useProjectStore.getState().project
    const live =
      applied.multicam && applied.clips.length > 0
        ? spansOfClips(applied.clips, applied.multicam)
        : plan.cut.spans
    const onLive = <T extends Omit<TextOverlay, 'id'>>(xs: readonly T[]): T[] =>
      live === plan.cut.spans ? [...xs] : mapTelopsToTimeline(xs, plan.cut.spans, live)
    const liveEffects = onLive(effectTelops)
    await placeSounds(plan.selection.kept, live, liveEffects, [...onLive(telops), ...liveEffects])
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
    roughCut: null,
    telopReviews: [],
    colorIssues: [],
    denoiseFailures: [],
    effects: [],
    effectChosen: [],
    lastSpans: [],
    speechTelops: [],
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
    setTargetMinutes: (minutes) => set({ targetMinutes: Math.max(0, minutes) }),
    setEditNote: (note) => set({ editNote: note }),
    setKeep: (sceneId, keep) =>
      set((s) => {
        const next = { ...s.keep }
        if (keep === undefined) delete next[sceneId]
        else next[sceneId] = keep
        return { keep: next }
      }),
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
          const short = buildShortProject(
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
          const base = `${folder}/${safeFileBaseName(short.name)}`
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
      try {
        await buildAndApply()
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

    addLog: (text) => log(text),
    setScreenOpen: (open) => set({ screenOpen: open }),

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
        roughCut: null,
        telopReviews: [],
        colorIssues: [],
        denoiseFailures: [],
        effects: [],
        effectChosen: [],
        lastSpans: [],
        speechTelops: []
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
        roughCut: null,
        telopReviews: [],
        colorIssues: [],
        denoiseFailures: [],
        effects: [],
        effectChosen: [],
        lastSpans: [],
        speechTelops: []
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
    markReviewed: (key, reviewed) => useProjectStore.getState().setReviewed(key, reviewed)
  }
})

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

// 別のプロジェクトを開いた・新しく作ったら、前の回の自動編集の結果を捨てる
// (残すと「仮編集を作り直す」が前の回の場面の区切りで今の回を切り、要確認にも前の回の項目が出る)
onProjectSwitch(() => {
  const pipeline = usePipelineStore.getState()
  // 自動編集の途中で「開く / 新規 / 自動保存を復元」すると、resetResults だけでは
  // 既に走っている main 側の同期・ASR・イベント検出が生き残る。完了後にその古い結果が
  // 新しいプロジェクトへ書き込まれるため、切替時はまず処理を中止する。
  if (pipeline.running) pipeline.cancel()
  pipeline.resetResults()
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

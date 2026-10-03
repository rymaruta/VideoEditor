import { isImagePath } from '@shared/mediaExtensions'
import { stillAssetFrom } from '../lib/stillAsset'
import { coverageOfClips, hasOverrides, updateOverrides } from '@shared/roughCut/overrides'
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
import { useProjectStore } from './projectStore'
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
  scenesFor
} from '../lib/roughCutPlan'
import { placeTelopsAvoidingFaces } from '../lib/telopPlacement'
import { AUTO_PLACE_CONFIDENCE, type EffectProposal } from '@shared/telop/effects'
import type { RoughCut } from '@shared/roughCut/build'
import { formatIpcError } from '../lib/ipcError'
import { emitMenuCommand } from '../lib/menuCommands'
import { detectTurns, placeEnvelope, TURN_RATE, type MicTrack } from '@shared/diarize/micTurns'
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
}

export const STEPS: { id: StepId; label: string }[] = [
  { id: 'ingest', label: '取り込み・整理' },
  { id: 'sync', label: 'カメラ・マイクの同期' },
  { id: 'timeline', label: 'タイムラインに並べる' },
  { id: 'color', label: 'カメラの色合わせ' },
  { id: 'denoise', label: 'ピンマイクのノイズ除去' },
  { id: 'speakers', label: '話者の判定' },
  { id: 'transcribe', label: '文字起こし' },
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
  /** 場面の判定を AI でしたか、簡易の点数か */
  judgeSource: 'ai' | 'heuristic' | null
  /** 画面で手で決めた「残す / 落とす」 */
  keep: Record<string, boolean>
  /** 演出テロップの提案(AI)と、置くと決めたもの */
  effects: EffectProposal[]
  effectChosen: string[]
  /** 今の仮編集の、タイムラインと共通の時刻の対応(演出テロップを置き直すのに使う) */
  lastSpans: RoughCut['spans']
  /** 演出テロップを置く/外す(すぐタイムラインに反映する) */
  setEffectChosen: (id: string, chosen: boolean) => void
  /** 顔の検出で、上下どちらに置いても顔に掛かった発言テロップ(要確認) */
  telopReviews: { startTime: number; text: string }[]
  /** 色を合わせられなかったカメラ(要確認に出す) */
  colorIssues: { name: string; verdict: Exclude<ColorMatchVerdict, 'matched' | 'same'> }[]
  /** ノイズ除去ができなかったピンマイク(要確認に出す) */
  denoiseFailures: { fileName: string; error: string }[]
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

  setScreenOpen: (open: boolean) => void
  scanFolder: (root: string) => Promise<void>
  updateSource: (
    id: string,
    patch: Partial<Pick<EditableSource, 'name' | 'kind' | 'subject'>>
  ) => void
  runPipeline: () => Promise<void>
  cancel: () => void
  markReviewed: (key: string, reviewed: boolean) => void
  reset: () => void
}

const initialSteps = (): Record<StepId, StepStatus> => ({
  ingest: { state: 'wait', percent: 0 },
  sync: { state: 'wait', percent: 0 },
  timeline: { state: 'wait', percent: 0 },
  color: { state: 'wait', percent: 0 },
  denoise: { state: 'wait', percent: 0 },
  speakers: { state: 'wait', percent: 0 },
  transcribe: { state: 'wait', percent: 0 },
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
    set((s) => ({ steps: { ...s.steps, [id]: { ...s.steps[id], ...status } } }))

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
    const turns = detectTurns(tracks)
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
        speaker: mics.length > 0 ? nameOf.get(j.turn.micId) : undefined,
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
          .map((x) => ({ fileName: x.a.fileName, error: x.r.error ?? '' }))
      })
      results.forEach((r, i) => {
        if (r.cleaned) changes[assets[i].id] = r.cleaned
        else
          log(
            `ノイズ除去: ${assets[i].fileName} はできませんでした(元の録音のまま): ${r.error ?? ''}`
          )
      })
      useProjectStore.getState().setAssetsDenoised(changes)
      const done = Object.keys(changes).length
      setStep('denoise', {
        state: done > 0 ? 'done' : 'error',
        percent: 100,
        note: `${done}/${assets.length} 本`
      })
      log(`ピンマイクのノイズ除去: ${done} 本(素材一覧の右クリックで外せます)`)
    } catch (e) {
      const msg = formatIpcError(e)
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
    try {
      const kit = await window.api.showKitScan(folder)
      const judged = new Map(get().judgements.map((j) => [j.sceneId, j]))
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
        effects,
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
      useProjectStore.getState().setAutoSounds(
        [
          { role: 'se', clips: se },
          { role: 'bgm', clips: bgm }
        ],
        assets
      )
      useProjectStore.getState().setAutoCg(cg, assets)
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
    const scenes = scenesFor(project, info)
    const range = cameraRange(info)
    const { geminiApiKey: apiKey, aiProvider: provider } = useSettingsStore.getState()
    const { judgements, source, failure, model, device } = await judgeScenes(
      scenes,
      range.end - range.start,
      {
        provider,
        apiKey,
        episodeName: project.name,
        targetSec: get().targetMinutes * 60 || range.end - range.start,
        note: get().editNote || undefined
      },
      (p) => setStep('structure', { percent: p.percent, note: p.note })
    )
    set({ scenes, judgements, judgeSource: source, keep: {} })
    const highlights = judgements.filter((j) => j.kind === 'highlight').length
    const unneeded = judgements.filter((j) => j.kind === 'unneeded').length
    setStep('structure', {
      state: 'done',
      percent: 100,
      note: `場面 ${scenes.length} · 見どころ ${highlights} · 不要 ${unneeded}${source === 'ai' ? ' · AI' : ' · 簡易'}`
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
    const overrides = project.roughCutAuto
      ? updateOverrides(
          project.cutOverrides,
          project.roughCutAuto,
          coverageOfClips(project.clips, info)
        )
      : project.cutOverrides
    const plan = planRoughCut(project, info, get().scenes, get().judgements, activity, {
      overrides,
      targetSec: get().targetMinutes * 60,
      keep: get().keep,
      styles: usePresetStore.getState().captionPresets,
      dictionary: parseDictionary(useSettingsStore.getState().telopDictionary),
      style: useSettingsStore.getState().showStyle?.style
    })
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
    try {
      const placed = await placeTelopsAvoidingFaces(
        plan.telops,
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
      setStep('placement', { state: 'error', note: formatIpcError(e) })
      log(`顔の検出ができませんでした(テロップは下のまま): ${formatIpcError(e)}`)
    }
    // 演出テロップ: 提案は最初の1回だけ AI に頼み、作り直しでは選んだものを置き直す
    if (get().effects.length === 0 && get().steps.effects.state !== 'done') {
      const { geminiApiKey: apiKey, aiProvider: provider } = useSettingsStore.getState()
      if (provider === 'off' || (provider === 'gemini' && !apiKey)) {
        setStep('effects', {
          state: 'skipped',
          note:
            provider === 'off'
              ? 'AI を使わない設定です'
              : 'Gemini の鍵がありません(このPCの AI に切り替えると提案します)'
        })
      } else {
        setStep('effects', { state: 'run', percent: 30, note: 'AI が提案中' })
        try {
          const proposals = await proposeEffects(
            effectLines(project, info, plan.cut.spans),
            {
              provider,
              apiKey,
              episodeName: project.name,
              note: get().editNote || undefined
            },
            (p) => setStep('effects', { percent: p.percent, note: p.note })
          )
          const auto = proposals
            .filter((p) => p.confidence >= AUTO_PLACE_CONFIDENCE)
            .map((p) => p.id)
          set({ effects: proposals, effectChosen: auto })
          setStep('effects', {
            state: 'done',
            percent: 100,
            note: `提案 ${proposals.length} · 自動で置いた ${auto.length}`
          })
          log(`演出テロップ: 提案 ${proposals.length} 件(自信の高い ${auto.length} 件を置きました)`)
        } catch (e) {
          setStep('effects', { state: 'error', note: formatIpcError(e) })
          log(`演出テロップの提案ができませんでした: ${formatIpcError(e)}`)
        }
      }
    }
    const effectTelops = effectOverlays(
      get().effects,
      new Set(get().effectChosen),
      project,
      info,
      plan.cut.spans,
      usePresetStore.getState().captionPresets
    )
    set({ lastSpans: plan.cut.spans })
    useProjectStore.getState().applyRoughCut(plan.cut, [...telops, ...effectTelops], overrides)
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
    await placeSounds(plan.selection.kept, plan.cut.spans, effectTelops, [
      ...telops,
      ...effectTelops
    ])
    log(
      `仮編集を作りました: ${plan.selection.kept.length} 場面 · ${formatMinutes(plan.cut.duration)} · ショット ${switches} · 発言テロップ ${telops.length}`
    )
  }

  return {
    targetMinutes: 0,
    editNote: '',
    scenes: [],
    judgements: [],
    judgeSource: null,
    keep: {},
    roughCut: null,
    telopReviews: [],
    colorIssues: [],
    denoiseFailures: [],
    effects: [],
    effectChosen: [],
    lastSpans: [],
    setEffectChosen: (id, chosen) => {
      const next = chosen
        ? [...new Set([...get().effectChosen, id])]
        : get().effectChosen.filter((x) => x !== id)
      set({ effectChosen: next })
      // 選び直したら、前に手で消していても置き直す
      if (chosen) useProjectStore.getState().undismissTelops([`e:${id}`])
      const project = useProjectStore.getState().project
      if (!project.multicam || get().lastSpans.length === 0) return
      useProjectStore
        .getState()
        .setEffectTelops(
          effectOverlays(
            get().effects,
            new Set(next),
            project,
            project.multicam,
            get().lastSpans,
            usePresetStore.getState().captionPresets
          )
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
    rebuildRoughCut: async () => {
      if (get().running || get().scenes.length === 0) return
      set({ running: true })
      try {
        await buildAndApply()
      } catch (e) {
        setStep('angles', { state: 'error', note: formatIpcError(e) })
        log(`仮編集を作り直せませんでした: ${formatIpcError(e)}`)
      } finally {
        set({ running: false })
      }
    },
    asrDevice: null,
    root: null,
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

    reset: () =>
      set({
        root: null,
        scan: null,
        sources: [],
        steps: initialSteps(),
        report: null,
        syncedFiles: [],
        log: [],
        scenes: [],
        judgements: [],
        judgeSource: null,
        keep: {},
        roughCut: null,
        telopReviews: [],
        colorIssues: [],
        denoiseFailures: [],
        effects: [],
        effectChosen: [],
        lastSpans: []
      }),

    scanFolder: async (root) => {
      set({ root, scan: null, sources: [], steps: initialSteps(), report: null })
      setStep('ingest', { state: 'run', percent: 0, note: 'ファイルを探しています' })
      log(`収録フォルダを読み込みます: ${root}`)
      const off = window.api.onFootageScanProgress(({ done, total }) =>
        setStep('ingest', { percent: (done / Math.max(1, total)) * 100, note: `${done}/${total}` })
      )
      try {
        const scan = await window.api.footageScan(root)
        const remembered = readSourceNames()
        const sources: EditableSource[] = scan.sources.map((s: FootageSource) => ({
          id: s.id,
          name: remembered[s.id] ?? s.name,
          kind: s.kind,
          basis: s.basis,
          files: s.files
        }))
        set({ scan, sources })
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
        report = await window.api.syncRun(files)
      } catch (e) {
        const msg = formatIpcError(e)
        const canceled = msg.includes('SYNC_CANCELED')
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
        const layout = buildMulticamLayout(
          used.map((s) => ({ id: s.id, name: s.name, kind: s.kind as SourceKind })),
          files.map((f) => ({ id: f.id, sourceId: f.sourceId, duration: f.duration })),
          report.placements
        )
        if (!layout) throw new Error('同期できたカメラがありません')
        const assets: MediaAsset[] = []
        const assetIdOf: Record<string, string> = {}
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          const meta = await window.api.probeMedia(f.path)
          let thumbnailDataUrl: string | undefined
          if (meta.hasVideo) {
            thumbnailDataUrl = await window.api
              .generateThumbnail(f.path, Math.min(1, meta.duration / 2))
              .catch(() => undefined)
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
            subject: u.subject
          }))
        )
        // 再生できない形式(HEVC など)は、素材一覧の側でプレビュー用の変換を始める
        emitMenuCommand('assets.checkPreview')
        void window.api.libraryRemember(assets.map((a) => a.filePath)).catch(() => {})
        setStep('timeline', {
          state: 'done',
          percent: 100,
          note: `本編 ${layout.main.length} 本 · カメラ ${layout.cameras.length} · マイク ${layout.mics.length}${layout.leftOut.length ? ` · 並べなかった ${layout.leftOut.length} 本` : ''}`
        })
        log(
          `タイムラインに並べました(基準カメラ: ${used.find((s) => s.id === layout.anchorSourceId)?.name ?? ''})`
        )
        await matchColors()
        await denoiseMics()
        await transcribeEpisode(used, files, report, assetIdOf, layout.anchorSourceId)
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
            'structure',
            'cut',
            'angles',
            'placement'
          ] as StepId[]
        ).find((id) => get().steps[id].state === 'run')
        const canceled = msg.includes('ASR_CANCELED')
        if (current)
          setStep(current, {
            state: canceled ? 'wait' : 'error',
            note: canceled ? '中止しました' : msg
          })
        log(canceled ? '文字起こしを中止しました' : `止まりました: ${msg}`)
      } finally {
        set({ running: false })
      }
    },

    cancel: () => {
      void window.api.syncCancel()
      void window.api.asrCancel()
    },

    // 確認済みはプロジェクトに保存する(開き直しても残る)
    markReviewed: (key, reviewed) => useProjectStore.getState().setReviewed(key, reviewed)
  }
})

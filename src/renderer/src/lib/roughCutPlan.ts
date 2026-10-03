import { countEvents } from '@shared/events/audioEvents'
import {
  applyAngleOverrides,
  applyCutOverrides,
  type CutOverrides
} from '@shared/roughCut/overrides'
import type { ShowStyle } from '@shared/style/showStyle'
import type { Project, TextOverlay } from '@shared/types'
import { toCommon, type MulticamInfo } from '@shared/sync/multicam'
import {
  buildScenes,
  heuristicJudgements,
  selectScenes,
  type Scene,
  type SceneJudgement,
  type Selection,
  type TimedLine
} from '@shared/structure/scenes'
import {
  buildStructurePrompt,
  chunkScenes,
  parseStructureAnswer,
  structureSchema
} from '@shared/structure/llm'
import type { AiProvider } from '@shared/llm'
import { askAiJson, type AiProgress } from './ai'
import { tightenRanges, totalLength, type CutRange } from '@shared/cut/tighten'
import { chooseAngles, type Shot } from '@shared/angles/choose'
import { buildRoughCut, roughTimelineAt, type RoughCut } from '@shared/roughCut/build'
import { activityMask, placeEnvelope, TURN_RATE, type MicTrack } from '@shared/diarize/micTurns'
import { utteranceToTelopChunks } from '@shared/telop/fromTranscript'
import { applyLook, styleForSpeaker, type TelopStyleDef } from '@shared/telop/styles'
import { defaultTextStyle } from '@shared/textStyle'
import {
  buildEffectPrompt,
  effectSchema,
  EFFECT_DURATION_SEC,
  EFFECT_LABEL,
  effectStyle,
  parseEffectAnswer,
  type EffectLine,
  type EffectProposal
} from '@shared/telop/effects'
import { stackSimultaneousTelops } from '@shared/telop/stack'
import { textCanvasSize } from '@shared/resolution'
import type { DictionaryEntry } from '@shared/telop/polish'

/**
 * 仮編集(計画書 フェーズ2: 構成 → カット → アングルの切り替え)を、企画の文字起こしと同期結果から作る。
 * 計算は `@shared/structure` `@shared/cut` `@shared/angles` `@shared/roughCut`。ここはそれをつなぐだけ。
 */

/** 発話を共通の時間軸の行にする(声を拾った素材の位置から換算) */
export function timedLines(project: Project, info: MulticamInfo): TimedLine[] {
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const out: TimedLine[] = []
  for (const u of project.transcript ?? []) {
    const f = fileOf.get(u.assetId)
    if (!f) continue
    out.push({
      id: u.id,
      speaker: u.speaker,
      start: toCommon(f, u.sourceStart),
      end: toCommon(f, u.sourceEnd),
      text: u.text,
      overlap: u.overlap
    })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** 共通の時間軸で、どれかのカメラが録っている範囲 */
export function cameraRange(info: MulticamInfo): { start: number; end: number } {
  const cams = new Set(info.sources.filter((s) => s.kind === 'camera').map((s) => s.id))
  const files = info.files.filter((f) => cams.has(f.sourceId))
  return {
    start: Math.min(...files.map((f) => f.start)),
    end: Math.max(...files.map((f) => f.start + f.duration / f.rate))
  }
}

/** マイク(無ければ基準カメラ)の音で、何か鳴っている所(100Hz)。素材の音の大きさはキャッシュから読む */
export async function loadActivity(project: Project, info: MulticamInfo): Promise<Uint8Array> {
  const pathOf = new Map(project.assets.map((a) => [a.id, a.filePath]))
  const mics = info.sources.filter((s) => s.kind === 'mic')
  const sources = mics.length > 0 ? mics : info.sources.filter((s) => s.id === info.anchorSourceId)
  const files = info.files.filter(
    (f) => sources.some((s) => s.id === f.sourceId) && pathOf.has(f.assetId)
  )
  const envelopes = await window.api.footageEnvelopes(files.map((f) => pathOf.get(f.assetId)!))
  const length = Math.ceil(
    Math.max(0, ...files.map((f) => f.start + f.duration / f.rate)) * TURN_RATE
  )
  const tracks: MicTrack[] = sources.map((s) => {
    const env = new Float32Array(length).fill(NaN)
    files.forEach((f, i) => {
      if (f.sourceId === s.id) placeEnvelope(envelopes[i], f.start, f.rate, length, env)
    })
    return { id: s.id, envelope: env }
  })
  return activityMask(tracks)
}

/**
 * 場面ごとの判定。Gemini の鍵があれば AI に、無ければ(または失敗したら)簡易の点数で。
 * AI の答えが無かった場面は簡易の点数で埋める。
 */
export async function judgeScenes(
  scenes: Scene[],
  totalSec: number,
  options: {
    provider: AiProvider
    apiKey: string
    episodeName: string
    targetSec: number
    note?: string
  },
  onProgress?: (p: AiProgress) => void
): Promise<{
  judgements: SceneJudgement[]
  source: 'ai' | 'heuristic'
  failure?: string
  model?: string
  device?: string
}> {
  const fallback = heuristicJudgements(scenes)
  if (options.provider === 'off' || (options.provider === 'gemini' && !options.apiKey)) {
    return { judgements: fallback, source: 'heuristic' }
  }
  const chunks = chunkScenes(scenes)
  const answerFormat = options.provider === 'local' ? 'keyed' : 'list'
  const got = new Map<string, SceneJudgement>()
  let model: string | undefined
  let device: string | undefined
  try {
    const r = await askAiJson(
      options.provider,
      options.apiKey,
      chunks.map((c) => ({
        prompt: buildStructurePrompt(c, totalSec, { ...options, answerFormat }),
        schema: structureSchema(c),
        maxTokens: 200 * c.length + 200
      })),
      onProgress
    )
    model = r.model
    device = r.device
    r.results.forEach((answer, i) => {
      if (answer === null) return
      for (const j of parseStructureAnswer(answer, chunks[i])) got.set(j.sceneId, j)
    })
  } catch (e) {
    return {
      judgements: fallback,
      source: 'heuristic',
      failure: e instanceof Error ? e.message : String(e)
    }
  }
  if (got.size === 0)
    return { judgements: fallback, source: 'heuristic', failure: 'AI が答えませんでした' }
  return {
    judgements: scenes.map((s) => got.get(s.id) ?? fallback.find((f) => f.sceneId === s.id)!),
    source: 'ai',
    model,
    device
  }
}

export interface RoughCutPlan {
  selection: Selection
  pieces: CutRange[]
  shots: Shot[]
  cut: RoughCut
  telops: Omit<TextOverlay, 'id'>[]
}

/**
 * 選んだ場面から、カット → アングル → 仮編集の中身 → 発言テロップ を作る。
 * `keep` で場面ごとに残す/落とすを手で決められる(画面の「構成」タブ)。
 */
export function planRoughCut(
  project: Project,
  info: MulticamInfo,
  scenes: Scene[],
  judgements: SceneJudgement[],
  activity: Uint8Array,
  options: {
    targetSec: number
    keep?: Record<string, boolean>
    styles: readonly TelopStyleDef[]
    dictionary?: readonly DictionaryEntry[]
    /** 番組スタイル(過去回から学んだ間・ショットの長さ・周りの音の音量)。無ければ既定値 */
    style?: ShowStyle
    /** 本編の人の修正(削った・足した区間、替えたカメラ)。作り直しても当て直す */
    overrides?: CutOverrides
  }
): RoughCutPlan {
  const tighten = options.style
    ? { maxPauseSec: options.style.maxPauseSec, keepPauseSec: options.style.keepPauseSec }
    : {}
  const lines = timedLines(project, info)
  const speech = lines.map((l) => ({ start: l.start, end: l.end }))
  // 長さの見込みは、場面ごとに詰めた後の長さで測る
  const tightenedLength = new Map(
    scenes.map((s) => [s.id, totalLength(tightenRanges([s], activity, speech, tighten))])
  )
  const auto = selectScenes(
    scenes,
    judgements,
    options.targetSec || Infinity,
    (s) => tightenedLength.get(s.id) ?? s.end - s.start
  )
  // 手で決めた分を上書きする
  const keepSet = new Set(auto.kept)
  for (const [id, keep] of Object.entries(options.keep ?? {})) {
    if (keep) keepSet.add(id)
    else keepSet.delete(id)
  }
  const kept = scenes.filter((s) => keepSet.has(s.id))
  const selection: Selection = {
    kept: kept.map((s) => s.id),
    dropped: scenes
      .filter((s) => !keepSet.has(s.id))
      .map((s) => ({
        sceneId: s.id,
        why: judgements.find((j) => j.sceneId === s.id)?.kind === 'unneeded' ? 'unneeded' : 'length'
      })),
    estimated: kept.reduce((t, s) => t + (tightenedLength.get(s.id) ?? 0), 0)
  }

  const tightened = tightenRanges(
    kept.map((s) => ({ start: s.start, end: s.end, sceneId: s.id })),
    activity,
    speech,
    tighten
  )
  const pieces = options.overrides ? applyCutOverrides(tightened, options.overrides) : tightened
  const cameras = info.sources
    .filter((s) => s.kind === 'camera')
    .map((s) => ({
      id: s.id,
      subject: s.subject,
      coverage: info.files
        .filter((f) => f.sourceId === s.id)
        .map((f) => ({ start: f.start, end: f.start + f.duration / f.rate }))
    }))
  const chosen = chooseAngles(
    pieces,
    cameras,
    info.anchorSourceId,
    lines,
    options.style
      ? { minShotSec: options.style.minShotSec, maxShotSec: options.style.maxShotSec }
      : {}
  )
  const shots = options.overrides
    ? applyAngleOverrides(chosen, options.overrides.angles, info)
    : chosen
  const cut = buildRoughCut(shots, info, { ambienceVolume: options.style?.ambienceVolume })

  // 発言テロップ: 話者に割り当てたテロップスタイルで、仮編集の時刻に置く
  const base = defaultTextStyle()
  const telops: Omit<TextOverlay, 'id'>[] = []
  const fileOfAsset = new Map(info.files.map((f) => [f.assetId, f]))
  for (const u of project.transcript ?? []) {
    const f = fileOfAsset.get(u.assetId)
    if (!f) continue
    const def = styleForSpeaker(options.styles, u.speaker)
    const chunks = utteranceToTelopChunks(u, {
      dictionary: options.dictionary,
      maxLineChars: options.style?.telopLineChars,
      minDurationSec: options.style?.telopMinSec
    })
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]
      const start = roughTimelineAt(cut.spans, toCommon(f, chunk.sourceStart))
      if (start === null) continue
      // 終わりがカットで落ちた所に掛かるなら、その区間の終わりまで
      const commonEnd = toCommon(f, chunk.sourceEnd)
      const span = cut.spans.find(
        (sp) => start >= sp.timeline - 1e-6 && start < sp.timeline + (sp.end - sp.start)
      )!
      const end = span.timeline + (Math.min(commonEnd, span.end) - span.start)
      if (end - start < 0.3) continue
      telops.push({
        text: chunk.text,
        startTime: start,
        endTime: end,
        style: def ? applyLook(base, def.style) : { ...base },
        styleId: def?.id,
        speaker: u.speaker,
        source: 'auto',
        utteranceId: u.id,
        utteranceChunk: ci
      })
    }
  }
  telops.sort((a, b) => a.startTime - b.startTime)
  // 声が重なった所は、後から出たテロップを1段上へ
  const stacked = stackSimultaneousTelops(telops, textCanvasSize(project.aspectRatio).h)
  return { selection, pieces, shots, cut, telops: stacked }
}

/** 場面を作る(カメラが録っている範囲で) */
export function scenesFor(project: Project, info: MulticamInfo): Scene[] {
  const scenes = buildScenes(timedLines(project, info), cameraRange(info))
  // 笑い・歓声を検出していれば、場面ごとの回数を付ける(判定と AI への文に使う)
  const events = project.audioEvents
  if (!events || events.length === 0) return scenes
  return scenes.map((s) => ({ ...s, ...countEvents(events, s.start, s.end) }))
}

/** 演出テロップの提案に渡す発言(仮編集に残っているものだけ、時刻は仮編集のタイムライン) */
export function effectLines(
  project: Project,
  info: MulticamInfo,
  spans: RoughCut['spans']
): EffectLine[] {
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const out: EffectLine[] = []
  for (const u of project.transcript ?? []) {
    const f = fileOf.get(u.assetId)
    if (!f) continue
    const t = roughTimelineAt(spans, toCommon(f, u.sourceStart))
    if (t === null) continue
    out.push({ id: u.id, speaker: u.speaker, text: u.text, start: t })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** AI に演出テロップを提案させる(発言は 200 件ずつ) */
export async function proposeEffects(
  lines: EffectLine[],
  options: {
    provider: Exclude<AiProvider, 'off'>
    apiKey: string
    episodeName: string
    note?: string
  },
  onProgress?: (p: AiProgress) => void
): Promise<EffectProposal[]> {
  const chunks: EffectLine[][] = []
  for (let i = 0; i < lines.length; i += 200) chunks.push(lines.slice(i, i + 200))
  const r = await askAiJson(
    options.provider,
    options.apiKey,
    chunks.map((c) => ({
      prompt: buildEffectPrompt(c, options.episodeName, options.note),
      schema: effectSchema(c),
      maxTokens: 2048
    })),
    onProgress
  )
  return r.results.flatMap((answer, i) =>
    answer === null ? [] : parseEffectAnswer(answer, chunks[i])
  )
}

/** 選んだ提案を、仮編集のタイムラインに置く(発言の終わりから。前の演出テロップとは重ねない) */
export function effectOverlays(
  proposals: readonly EffectProposal[],
  chosen: ReadonlySet<string>,
  project: Project,
  info: MulticamInfo,
  spans: RoughCut['spans'],
  styles: readonly TelopStyleDef[]
): Omit<TextOverlay, 'id'>[] {
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const utterance = new Map((project.transcript ?? []).map((u) => [u.id, u]))
  const out: Omit<TextOverlay, 'id'>[] = []
  let lastEnd = -Infinity
  const placed = proposals
    .filter((p) => chosen.has(p.id))
    .map((p) => {
      const u = utterance.get(p.afterLineId)
      const f = u ? fileOf.get(u.assetId) : undefined
      const t = u && f ? roughTimelineAt(spans, toCommon(f, u.sourceEnd) - 0.05) : null
      return { p, t }
    })
    .filter((x): x is { p: EffectProposal; t: number } => x.t !== null)
    .sort((a, b) => a.t - b.t)
  for (const { p, t } of placed) {
    const start = Math.max(t, lastEnd + 0.2)
    // 「演出・ツッコミ」のように名前の付いたテロップスタイルがあれば、そちらを使う
    const named = styles.find((s) => s.name === `演出・${EFFECT_LABEL[p.kind]}`)
    out.push({
      text: p.text,
      startTime: start,
      endTime: start + EFFECT_DURATION_SEC,
      style: named ? { ...named.style } : effectStyle(p.kind),
      styleId: named?.id,
      source: 'auto',
      effectId: p.id
    })
    lastEnd = start + EFFECT_DURATION_SEC
  }
  return out
}

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
import { buildStructurePrompt, chunkScenes, parseStructureAnswer } from '@shared/structure/llm'
import { tightenRanges, totalLength, type CutRange } from '@shared/cut/tighten'
import { chooseAngles, type Shot } from '@shared/angles/choose'
import { buildRoughCut, roughTimelineAt, type RoughCut } from '@shared/roughCut/build'
import { activityMask, placeEnvelope, TURN_RATE, type MicTrack } from '@shared/diarize/micTurns'
import { utteranceToTelopChunks } from '@shared/telop/fromTranscript'
import { applyLook, styleForSpeaker, type TelopStyleDef } from '@shared/telop/styles'
import { defaultTextStyle } from '@shared/textStyle'
import { fetchJson, parseModelJsonObject } from './httpJson'

/**
 * 仮編集(計画書 フェーズ2: 構成 → カット → アングルの切り替え)を、企画の文字起こしと同期結果から作る。
 * 計算は `@shared/structure` `@shared/cut` `@shared/angles` `@shared/roughCut`。ここはそれをつなぐだけ。
 */

const GEMINI_MODEL = 'gemini-flash-latest'

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
}

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
  options: { apiKey: string; episodeName: string; targetSec: number; note?: string },
  onProgress?: (done: number, total: number) => void
): Promise<{ judgements: SceneJudgement[]; source: 'ai' | 'heuristic'; failure?: string }> {
  const fallback = heuristicJudgements(scenes)
  if (!options.apiKey) return { judgements: fallback, source: 'heuristic' }
  const chunks = chunkScenes(scenes)
  const got = new Map<string, SceneJudgement>()
  try {
    for (let i = 0; i < chunks.length; i++) {
      onProgress?.(i, chunks.length)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(options.apiKey)}`
      const data = await fetchJson<GeminiResponse>(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: buildStructurePrompt(chunks[i], totalSec, options) }] }],
            generationConfig: { responseMimeType: 'application/json' }
          })
        },
        'Gemini API'
      )
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) continue
      for (const j of parseStructureAnswer(parseModelJsonObject(text, 'Gemini API'), chunks[i])) {
        got.set(j.sceneId, j)
      }
    }
  } catch (e) {
    return {
      judgements: fallback,
      source: 'heuristic',
      failure: e instanceof Error ? e.message : String(e)
    }
  }
  return {
    judgements: scenes.map((s) => got.get(s.id) ?? fallback.find((f) => f.sceneId === s.id)!),
    source: 'ai'
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
  options: { targetSec: number; keep?: Record<string, boolean>; styles: readonly TelopStyleDef[] }
): RoughCutPlan {
  const lines = timedLines(project, info)
  const speech = lines.map((l) => ({ start: l.start, end: l.end }))
  // 長さの見込みは、場面ごとに詰めた後の長さで測る
  const tightenedLength = new Map(
    scenes.map((s) => [s.id, totalLength(tightenRanges([s], activity, speech))])
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

  const pieces = tightenRanges(
    kept.map((s) => ({ start: s.start, end: s.end, sceneId: s.id })),
    activity,
    speech
  )
  const cameras = info.sources
    .filter((s) => s.kind === 'camera')
    .map((s) => ({
      id: s.id,
      subject: s.subject,
      coverage: info.files
        .filter((f) => f.sourceId === s.id)
        .map((f) => ({ start: f.start, end: f.start + f.duration / f.rate }))
    }))
  const shots = chooseAngles(pieces, cameras, info.anchorSourceId, lines)
  const cut = buildRoughCut(shots, info)

  // 発言テロップ: 話者に割り当てたテロップスタイルで、仮編集の時刻に置く
  const base = defaultTextStyle()
  const telops: Omit<TextOverlay, 'id'>[] = []
  const fileOfAsset = new Map(info.files.map((f) => [f.assetId, f]))
  for (const u of project.transcript ?? []) {
    const f = fileOfAsset.get(u.assetId)
    if (!f) continue
    const def = styleForSpeaker(options.styles, u.speaker)
    for (const chunk of utteranceToTelopChunks(u)) {
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
        utteranceId: u.id
      })
    }
  }
  telops.sort((a, b) => a.startTime - b.startTime)
  return { selection, pieces, shots, cut, telops }
}

/** 場面を作る(カメラが録っている範囲で) */
export function scenesFor(project: Project, info: MulticamInfo): Scene[] {
  return buildScenes(timedLines(project, info), cameraRange(info))
}

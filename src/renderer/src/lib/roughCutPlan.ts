import {
  CHEER_THRESHOLD,
  countEvents,
  LAUGH_THRESHOLD,
  type AudioEventWindow
} from '@shared/events/audioEvents'
import {
  countHype,
  detectHype,
  HYPE_LEAD_SEC,
  HYPE_TAIL_SEC,
  peakWindows,
  type HypeMoment,
  type PeakSpan
} from '@shared/structure/hype'
import {
  DEFAULT_POLICY,
  KIND_PROFILES,
  POLICY_PROFILES,
  type EditPolicy,
  type EpisodeKind
} from '@shared/structure/kind'
import {
  applyAngleOverrides,
  applyCutOverrides,
  type CutOverrides
} from '@shared/roughCut/overrides'
import type { AspectRatio } from '@shared/types'
import type { ShowStyle } from '@shared/style/showStyle'
import type { Project, TextOverlay, TextStyle } from '@shared/types'
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
import { mixLevelDb, snapCutsToQuiet } from '@shared/roughCut/snap'
import { activityMask, placeEnvelope, TURN_RATE, type MicTrack } from '@shared/diarize/micTurns'
import { settleTelopTimes, utteranceToTelopChunks } from '@shared/telop/fromTranscript'
import {
  speechLook,
  speechTelopStyle,
  styleForSpeaker,
  type TelopStyleDef
} from '@shared/telop/styles'
import {
  buildEffectPrompt,
  effectSchema,
  EFFECT_AT_LINE_START,
  effectDuration,
  EFFECT_FOLLOWS_LINE,
  EFFECT_LABEL,
  EFFECT_MIN_LINE_SEC,
  effectLane,
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
      overlap: u.overlap,
      source: f.sourceId
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
  const mask = activityMask(tracks)
  levelOfActivity.set(mask, mixLevelDb(tracks))
  sourceLevelsOfActivity.set(mask, new Map(tracks.map((t) => [t.id, mixLevelDb([t])])))
  return mask
}

/**
 * 「面白い所だけ」で場面を絞るときの山: 声の盛り上がり(前 12 秒・後 8 秒)と、笑い(10 秒の窓の前 4 秒・後 2 秒)
 */
export function peakSpans(
  hype: readonly HypeMoment[],
  events: readonly AudioEventWindow[] | undefined
): PeakSpan[] {
  return [
    ...hype.map((h) => ({ start: h.start, end: h.end, lead: HYPE_LEAD_SEC, tail: HYPE_TAIL_SEC })),
    ...(events ?? [])
      .filter((e) => e.laugh >= LAUGH_THRESHOLD || e.cheer >= CHEER_THRESHOLD)
      .map((e) => ({ start: e.start, end: e.end, lead: 4, tail: 2 }))
  ]
}

/** `loadActivity` で読んだ音源ごとの音の大きさ(dB、100Hz)。声の盛り上がりを話者ごとに測るのに使う */
const sourceLevelsOfActivity = new WeakMap<Uint8Array, Map<string, Float32Array>>()

/**
 * 声の盛り上がり(叫び・大声)。発話を拾った音源の音で測る(ピンマイクがあればその人のマイク、
 * 無ければ基準カメラの音)。`loadActivity` の後に呼ぶ
 */
export function hypeMomentsFor(
  project: Project,
  info: MulticamInfo,
  activity: Uint8Array
): HypeMoment[] {
  const levels = sourceLevelsOfActivity.get(activity)
  if (!levels) return []
  const fallback = levels.get(info.anchorSourceId) ?? [...levels.values()][0]
  return detectHype(timedLines(project, info), (l) => {
    const src = (l as TimedLine).source
    return (src ? levels.get(src) : undefined) ?? fallback
  })
}

/**
 * `loadActivity` で読んだ音の大きさ(全マイクを足した dB、100Hz)。カット点を静かな所へ寄せるのに使う。
 * 呼び出し側(自動編集の流れ)は鳴っている所の印だけを持ち回るので、印に結び付けて覚えておく
 */
const levelOfActivity = new WeakMap<Uint8Array, Float32Array>()

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
    kind?: EpisodeKind
  },
  onProgress?: (p: AiProgress) => void
): Promise<{
  judgements: SceneJudgement[]
  source: 'ai' | 'heuristic'
  failure?: string
  model?: string
  device?: string
}> {
  const fallback = heuristicJudgements(scenes, options.kind)
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
    /** 話者にスタイルを割り当てていない発言テロップの見た目(`speechLook`)。無ければ既定の型 */
    speechLook?: { style: TextStyle; styleId?: string }
    dictionary?: readonly DictionaryEntry[]
    /** 番組スタイル(過去回から学んだ間・ショットの長さ・周りの音の音量)。無ければ既定値 */
    style?: ShowStyle
    /** 番組の種類(場面の中を山の前後に絞るか・声の無い所を絵として残す長さ) */
    kind?: EpisodeKind
    /** 編集の方針(面白い所だけ・テンポよく・軽く整える)。無ければ種類の既定 */
    policy?: EditPolicy
    /** 山(叫び・笑い)。「面白い所だけ」で、場面の中を山の前後に絞るのに使う */
    peaks?: readonly PeakSpan[]
    /** 本編の人の修正(削った・足した区間、替えたカメラ)。作り直しても当て直す */
    overrides?: CutOverrides
    /** テロップを置く画面の縦横比(縦型のショートなど、元の企画と違うとき)。無ければ企画の縦横比 */
    aspectRatio?: AspectRatio
    /** 全マイクを足した音の大きさ(dB、100Hz)。無ければ `loadActivity` で読んだもの */
    level?: Float32Array
  }
): RoughCutPlan {
  const kind = options.kind ?? 'location'
  const profile = KIND_PROFILES[kind]
  const policy = POLICY_PROFILES[options.policy ?? DEFAULT_POLICY[kind]]
  const tighten = {
    ...profile.insert,
    ...(options.style
      ? { maxPauseSec: options.style.maxPauseSec, keepPauseSec: options.style.keepPauseSec }
      : {}),
    ...policy.tighten
  }
  const lines = timedLines(project, info)
  const speech = lines.map((l) => ({ start: l.start, end: l.end }))
  // 「面白い所だけ」のゲーム実況は、山のある場面を山の前後だけに絞る(山の無い場面は丸ごと)
  const narrow = (options.policy ?? DEFAULT_POLICY[kind]) === 'highlights' && profile.peakWindows
  const rangesOf = (s: Scene): CutRange[] =>
    (narrow ? peakWindows(s, options.peaks ?? [], speech) : null)?.map((w) => ({
      ...w,
      sceneId: s.id
    })) ?? [{ start: s.start, end: s.end, sceneId: s.id }]
  // 長さの見込みは、場面ごとに詰めた後の長さで測る
  const tightenedLength = new Map(
    scenes.map((s) => [s.id, totalLength(tightenRanges(rangesOf(s), activity, speech, tighten))])
  )
  const target = policy.useTarget ? options.targetSec : 0
  const auto = selectScenes(
    scenes,
    judgements,
    target || Infinity,
    (s) => tightenedLength.get(s.id) ?? s.end - s.start,
    target ? -Infinity : policy.minScoreWithoutTarget,
    policy.dropUnneeded
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
    estimated: kept.reduce((t, s) => t + (tightenedLength.get(s.id) ?? 0), 0),
    ...(auto.relaxed ? { relaxed: true } : {})
  }

  const tightened = tightenRanges(kept.flatMap(rangesOf), activity, speech, tighten)
  // 時間の飛ぶ切れ目を、近くのいちばん静かな所へ寄せる(短い音の途中で切らない)。
  // 人が足した・削った区間は人の決めた位置のまま(寄せた後に当てる)
  const level = options.level ?? levelOfActivity.get(activity)
  const snapped = level ? snapCutsToQuiet(tightened, level) : tightened
  const pieces = options.overrides ? applyCutOverrides(snapped, options.overrides) : snapped
  const cameras = info.sources
    // 顔カメラ(ゲーム実況)は切り替えに使わない(ワイプで常に出す)
    .filter((s) => s.kind === 'camera' && s.cameraRole !== 'face')
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
  const look = options.speechLook ?? speechLook(undefined, options.styles)
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
        style: speechTelopStyle(def ? def.style : look.style),
        styleId: def ? def.id : look.styleId,
        speaker: u.speaker,
        source: 'auto',
        utteranceId: u.id,
        utteranceChunk: ci
      })
    }
  }
  // 短い切れ目をつなぎ、読み切れない枚を延ばす(時間の飛ぶカットの切れ目と、本編の終わりは越えない)
  const settled = settleTelopTimes(telops, [
    ...cut.spans.slice(1).map((sp) => sp.timeline),
    cut.duration
  ])
  // 声が重なった所は、後から出たテロップを1段上へ
  const stacked = stackSimultaneousTelops(
    settled,
    textCanvasSize(options.aspectRatio ?? project.aspectRatio).h
  )
  return { selection, pieces, shots, cut, telops: stacked }
}

/** 場面を作る(カメラが録っている範囲で) */
export function scenesFor(
  project: Project,
  info: MulticamInfo,
  options: { kind?: EpisodeKind; hype?: readonly HypeMoment[] } = {}
): Scene[] {
  const scenes = buildScenes(
    timedLines(project, info),
    cameraRange(info),
    KIND_PROFILES[options.kind ?? 'location'].scene
  )
  const hype = options.hype
  // 笑い・歓声・声の盛り上がりを測っていれば、場面ごとの回数を付ける(判定と AI への文に使う)
  const events = project.audioEvents
  return scenes.map((s) => ({
    ...s,
    ...(events && events.length > 0 ? countEvents(events, s.start, s.end) : {}),
    ...(hype ? { hype: countHype(hype, s.start, s.end) } : {})
  }))
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
): Promise<{ proposals: EffectProposal[]; failed: number; total: number }> {
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
  // AI が答えを返せなかった区切りの数も返す(「提案が無い」と「答えられなかった」を分けて示す)
  return {
    proposals: r.results.flatMap((answer, i) =>
      answer === null ? [] : parseEffectAnswer(answer, chunks[i])
    ),
    failed: r.results.filter((a) => a === null).length,
    total: chunks.length
  }
}

/** 時刻で決まる演出テロップを、削った所の直後へ寄せてよい長さ(秒) */
export const TIMED_EFFECT_SNAP_SEC = 20

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
  // 画面の同じ場所に出るものだけ、前のテロップと間を空ける(左上の時刻と真ん中のツッコミは同時でよい)
  const laneEnd = new Map<string, number>()
  const placed = proposals
    .filter((p) => chosen.has(p.id))
    .map((p) => {
      const u = utterance.get(p.afterLineId)
      const f = u ? fileOf.get(u.assetId) : undefined
      // 笑い・時刻・章は時刻で、人物紹介・強調・字幕の類は発言の頭から、ほかは言い終わってから
      const at =
        p.at !== undefined
          ? p.at
          : u && f
            ? EFFECT_AT_LINE_START.has(p.kind)
              ? toCommon(f, u.sourceStart) + 0.05
              : toCommon(f, u.sourceEnd) - 0.05
            : null
      let t = at !== null ? roughTimelineAt(spans, at) : null
      // 時刻で決まる種類(章・時刻・笑い)が、間を詰めて削った場面の頭に当たったら、
      // その直後に残っている所の頭へ寄せる(寄せないと、章タイトルがほぼ必ず消える)
      if (t === null && at !== null && p.at !== undefined) {
        const next = spans
          .filter((sp) => sp.start >= at && sp.start - at <= TIMED_EFFECT_SNAP_SEC)
          .sort((a, b) => a.start - b.start)[0]
        if (next) t = next.timeline + 0.05
      }
      // 字幕の類(翻訳・方言・吹き出し)は発言と同じ長さだけ出す
      const lineSec =
        u && f && EFFECT_FOLLOWS_LINE.has(p.kind)
          ? Math.max(EFFECT_MIN_LINE_SEC, (u.sourceEnd - u.sourceStart) / (f.rate || 1))
          : null
      return { p, t, lineSec }
    })
    .filter((x): x is { p: EffectProposal; t: number; lineSec: number | null } => x.t !== null)
    .sort((a, b) => a.t - b.t)
  let lastName: Omit<TextOverlay, 'id'> | null = null
  for (const { p, t, lineSec } of placed) {
    const lane = effectLane(p.kind)
    // 名前どうしは同じ場所に出るので、前の名前を最低 0.5 秒は見せてから次を出す。
    // 0.5 秒未満で続くと、前の名前を下げても 0.5 秒は残るので2つが重なっていた
    const start =
      p.kind === 'name'
        ? lastName
          ? Math.max(t, lastName.startTime + 0.5)
          : t
        : Math.max(t, (laneEnd.get(lane) ?? -Infinity) + 0.2)
    const duration = lineSec ?? effectDuration(p.kind)
    // 次の人の名前が出るときは、前の人の名前を下げる(同じ場所に重ねない)
    if (p.kind === 'name' && lastName && lastName.endTime > start) lastName.endTime = start
    // 「演出・ツッコミ」のように名前の付いたテロップスタイルがあれば、そちらを使う
    const named = styles.find((s) => s.name === `演出・${EFFECT_LABEL[p.kind]}`)
    out.push({
      text: p.text,
      startTime: start,
      endTime: start + duration,
      style: named ? { ...named.style } : effectStyle(p.kind),
      styleId: named?.id,
      source: 'auto',
      effectId: p.id
    })
    if (p.kind !== 'name') laneEnd.set(lane, start + duration)
    else lastName = out[out.length - 1]
  }
  return out
}

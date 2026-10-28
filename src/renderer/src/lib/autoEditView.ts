/**
 * 自動編集の画面(Graphite 3 の「進み具合」「構成を決める」)に出すものを、企画と工程の
 * 状態から組み立てる純関数。**実際にあるデータだけ**を返す(無いものは空)。
 */
import type { Project } from '@shared/types'
import {
  describeCues,
  indistinctJudgements,
  sceneCues,
  type Scene,
  type SceneJudgement
} from '@shared/structure/scenes'
import { CHEER_THRESHOLD, LAUGH_THRESHOLD } from '@shared/events/audioEvents'

export type StepState = 'wait' | 'run' | 'done' | 'error' | 'skipped'

export interface Range {
  start: number
  end: number
}

/** 秒を m:ss(1 時間を超えたら h:mm:ss)に */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** 全体の進み具合(0〜1)。済んだ・省いた工程は 1、進行中は その割合 */
export function overallFraction(steps: readonly { state: StepState; percent: number }[]): number {
  if (steps.length === 0) return 0
  const sum = steps.reduce(
    (t, s) =>
      t +
      (s.state === 'done' || s.state === 'skipped'
        ? 1
        : s.state === 'run'
          ? Math.min(1, Math.max(0, s.percent / 100))
          : 0),
    0
  )
  return sum / steps.length
}

/**
 * 全体の進み具合の表示(割合・済んだ工程の数・文)。
 * - 動いている間: 済んだ・省いた工程と、進行中の割合(`overallFraction`)
 * - 止まった後(どれかの工程が失敗): 済んだ工程だけで数え、「止まりました」と添える。失敗の後の工程は
 *   「省略(仮編集がありません)」になるので、省略を数えると止まっているのに 93% と出ていた
 * - それ以外: 済んだ工程と省いた工程(番組素材フォルダが無い など)を合わせて数える。全部が済む・省くで
 *   終われば 100% · 14 / 14(作り直しの後も「12 / 14」と、終わっていない数が出ていた)
 */
export function overallProgress(
  steps: readonly { id?: string; state: StepState; percent: number }[],
  running: boolean,
  /** 失敗しても先へ進む工程(`CONTINUE_ON_ERROR`)。ここでの失敗は「止まった」にしない */
  continueOnError: ReadonlySet<string> = new Set()
): { percent: number; finished: number; total: number; stopped: boolean; text: string } {
  const total = steps.length
  const done = steps.filter((s) => s.state === 'done').length
  const skipped = steps.filter((s) => s.state === 'skipped').length
  const passedErrors = steps.filter(
    (s) => s.state === 'error' && s.id != null && continueOnError.has(s.id)
  ).length
  const stoppingError = steps.some(
    (s) => s.state === 'error' && !(s.id != null && continueOnError.has(s.id))
  )
  if (!running && stoppingError) {
    const percent = total > 0 ? Math.round((done / total) * 100) : 0
    return {
      percent,
      finished: done,
      total,
      stopped: true,
      text: `止まりました · ${done} / ${total} 工程`
    }
  }
  // 失敗しても先へ進んだ工程は「通り過ぎた」として数える(仮編集はできている)
  const percent = Math.round(
    (overallFraction(steps) + (total > 0 ? passedErrors / total : 0)) * 100
  )
  const finished = done + skipped + passedErrors
  const notes = [
    skipped > 0 ? `省略 ${skipped}` : '',
    passedErrors > 0 ? `失敗して先へ進んだ ${passedErrors}` : ''
  ].filter(Boolean)
  return {
    percent,
    finished,
    total,
    stopped: false,
    text: `${percent}% · ${finished} / ${total} 工程${notes.length > 0 ? `(${notes.join('・')})` : ''}`
  }
}

/** 重なり・接した区間をまとめ、時刻順に並べる */
export function mergeRanges(ranges: readonly Range[], joinGap = 0): Range[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + joinGap) last.end = Math.max(last.end, r.end)
    else out.push({ start: r.start, end: r.end })
  }
  return out
}

/** 収録の全体の長さ(共通の時刻)。同期の情報が無ければ 0 */
export function commonSpan(project: Project): number {
  const files = project.multicam?.files ?? []
  return files.reduce((m, f) => Math.max(m, f.start + f.duration / (f.rate || 1)), 0)
}

/** 機材ごとの録画のある区間(共通の時刻)。同期の情報から */
export function sourceLanes(project: Project): { id: string; name: string; ranges: Range[] }[] {
  const info = project.multicam
  if (!info) return []
  return info.sources
    .map((src) => ({
      id: src.id,
      name: src.name,
      ranges: mergeRanges(
        info.files
          .filter((f) => f.sourceId === src.id)
          .map((f) => ({ start: f.start, end: f.start + f.duration / (f.rate || 1) })),
        0.5
      )
    }))
    .filter((l) => l.ranges.length > 0)
}

/** 話者ごとの話している区間(共通の時刻)。文字起こしと同期の情報から。話者の分からない発話は外す */
export function speakerLanes(project: Project): { speaker: string; ranges: Range[] }[] {
  const info = project.multicam
  const transcript = project.transcript ?? []
  if (!info || transcript.length === 0) return []
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const by = new Map<string, Range[]>()
  for (const u of transcript) {
    if (!u.speaker) continue
    const f = fileOf.get(u.assetId)
    if (!f) continue
    const rate = f.rate || 1
    const list = by.get(u.speaker) ?? []
    list.push({ start: f.start + u.sourceStart / rate, end: f.start + u.sourceEnd / rate })
    by.set(u.speaker, list)
  }
  return (
    [...by.entries()]
      .map(([speaker, ranges]) => ({ speaker, ranges: mergeRanges(ranges, 1) }))
      // 長さの無い発話だけの話者は並べない(帯が無く、並べ替えで落ちる)
      .filter((l) => l.ranges.length > 0)
      .sort((a, b) => a.ranges[0].start - b.ranges[0].start)
  )
}

/** 笑い・歓声を検出した区間(共通の時刻) */
export function eventRanges(project: Project): { laugh: Range[]; cheer: Range[] } {
  const windows = project.audioEvents ?? []
  return {
    laugh: mergeRanges(
      windows.filter((w) => w.laugh > LAUGH_THRESHOLD).map((w) => ({ start: w.start, end: w.end }))
    ),
    cheer: mergeRanges(
      windows.filter((w) => w.cheer > CHEER_THRESHOLD).map((w) => ({ start: w.start, end: w.end }))
    )
  }
}

/** 場面のうち、誰かが話している割合(0〜1) */
export function speechRatio(scene: Scene): number {
  const len = scene.end - scene.start
  return len > 0 ? Math.min(1, Math.max(0, scene.speech / len)) : 0
}

export type ChipTone = 'accent' | 'ok' | 'auto' | 'neutral' | 'word'

export interface SceneChip {
  label: string
  tone: ChipTone
  /** 手で決めた印(琥珀の枠を付ける) */
  manual?: boolean
}

/**
 * 場面に添える理由の印(デザインの「理由と状態の印」)。笑い・歓声・盛り上がり・発話の割合・
 * 自動の判定・手で決めたかを、データのあるものだけ並べる
 */
export function sceneChips(
  scene: Scene,
  judgement: SceneJudgement | undefined,
  judgeSource: 'ai' | 'heuristic' | null,
  manual: boolean | undefined
): SceneChip[] {
  const chips: SceneChip[] = []
  if (scene.laughs) chips.push({ label: `笑い ${scene.laughs}`, tone: 'accent' })
  if (scene.cheers) chips.push({ label: `歓声 ${scene.cheers}`, tone: 'accent' })
  if (scene.hype) chips.push({ label: `盛り上がり ${scene.hype}`, tone: 'accent' })
  const ratio = speechRatio(scene)
  chips.push({ label: `発話 ${Math.round(ratio * 100)}%`, tone: ratio >= 0.5 ? 'ok' : 'neutral' })
  if (judgement?.kind === 'highlight')
    chips.push({ label: judgeSource === 'ai' ? 'AI · 見どころ' : '見どころ', tone: 'auto' })
  else if (judgement?.kind === 'unneeded')
    chips.push({ label: judgeSource === 'ai' ? 'AI · 不要' : '不要', tone: 'neutral' })
  if (manual === true) chips.push({ label: '手で残す', tone: 'accent', manual: true })
  else if (manual === false) chips.push({ label: '手で落とす', tone: 'neutral', manual: true })
  return chips
}

/** 場面の見出し: AI の見出し、無ければ最初の発言 */
export function sceneTitle(scene: Scene, judgement: SceneJudgement | undefined): string {
  if (judgement?.title) return judgement.title
  const first = scene.lines[0]
  if (!first) return '(会話なし)'
  return `${first.speaker ?? ''}「${first.text.slice(0, 30)}」`
}

/** 場面で話している人の数 */
export function speakerCount(scene: Scene): number {
  return new Set(scene.lines.map((l) => l.speaker).filter(Boolean)).size
}

/**
 * 場面の絵(サムネイル)を取る素材と時刻。共通の時刻 `t` を録っているカメラのうち、
 * 基準の機材を先に、無ければ最初に見つかったカメラ。カメラが無ければ null
 */
export function frameSourceAt(
  project: Project,
  t: number
): { filePath: string; at: number } | null {
  const info = project.multicam
  if (!info) return null
  const cameras = info.sources.filter((s) => s.kind === 'camera')
  cameras.sort(
    (a, b) => Number(b.id === info.anchorSourceId) - Number(a.id === info.anchorSourceId)
  )
  for (const cam of cameras) {
    for (const f of info.files) {
      if (f.sourceId !== cam.id) continue
      const rate = f.rate || 1
      if (t < f.start || t >= f.start + f.duration / rate) continue
      const asset = project.assets.find((a) => a.id === f.assetId)
      if (!asset?.hasVideo) continue
      return { filePath: asset.filePath, at: (t - f.start) * rate }
    }
  }
  return null
}

/** 場面の帯の色(Graphite 3。残す場面に順に当てる) */
export const SCENE_BAND_COLORS = ['#6b7cff', '#ff5fa2', '#a77bff', '#2ed3b7'] as const

/** 残す場面の何番目か(落とす場面は null)。帯の色を順に当てるのに使う */
export function keptOrder(
  scenes: readonly { id: string }[],
  keptOf: (id: string) => boolean
): Map<string, number | null> {
  const out = new Map<string, number | null>()
  let n = 0
  for (const sc of scenes) out.set(sc.id, keptOf(sc.id) ? n++ : null)
  return out
}

/**
 * 全体の帯の目盛り(6 本前後の切りのよい間隔)。右端に全体の長さを書くので、右端の 15% より後ろの
 * 目盛りは書かない(狭い列で「10:00」と「12:14」が重なっていた)
 */
export function rulerTicks(span: number): number[] {
  if (!(span > 0)) return []
  const step = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].find((v) => v >= span / 6) ?? 7200
  const out: number[] = []
  for (let t = 0; t <= span * 0.85; t += step) out.push(t)
  return out
}

/**
 * 落とした場面の、落とした理由(構成の一覧に出す)。人が落とした・「不要」の判定・長さに合わせた、のどれか。
 * 長さに合わせて落とした場面は、点数と中身の手掛かりも添える。判定が場面を区別できていない(全部に同じ点数)
 * ときは、中身の手掛かりで選んだことを書く(試し編集 第2回: 落とした理由が画面に出ず、「見どころ」の印のまま
 * 「残す」のチェックが外れているだけだった)
 */
export function droppedSceneReason(
  scene: Scene,
  judgement: SceneJudgement | undefined,
  judgements: readonly SceneJudgement[],
  /** 人が「残す」を外した */
  manual: boolean
): string {
  if (manual) return '手で落としました'
  if (judgement?.kind === 'unneeded') return '「不要」の判定で落としました'
  const cues = describeCues(sceneCues(scene))
  const same = indistinctJudgements(judgements)
  if (same && judgement && judgement.score === same.score)
    return `仕上がりの長さに合わせて落としました。判定がどの場面も同じ点(${same.score} 点)なので、中身の手掛かりの少ない場面から選びました(${cues})`
  return `仕上がりの長さに合わせて、点数の低い場面から落としました(${judgement ? `${judgement.score} 点 · ` : ''}${cues})`
}

import type { Project } from '../types'

/**
 * 番組スタイル(計画書 §7「学習」)。人が仕上げた過去回のプロジェクトから番組の癖を集計し、
 * 自動編集の既定値にする。集計するのは、人が直した結果に現れる「量」だけ:
 *
 * - 間の長さ: 発言テロップどうしの間(どこまでの間を残し、どこから詰めるか)
 * - 1ショットの長さ: 本編のクリップの長さ(アングルを替える最短・最長)
 * - SE の数: 1分あたり
 * - BGM・環境音(カメラの音)の音量
 *
 * 1本ずつ集計し、本どうしは中央値でまとめる(1本だけ特殊な回に引っぱられない)。
 * 値は自動編集が壊れない範囲に収める。
 */
export interface ShowStyle {
  /** これより長い間は詰める(秒) */
  maxPauseSec: number
  /** 詰めたあとに残す間(秒) */
  keepPauseSec: number
  /** 1ショットの最短・最長(秒) */
  minShotSec: number
  maxShotSec: number
  /** 1分あたりの SE の数の上限 */
  sePerMinute: number
  bgmVolume: number
  ambienceVolume: number
}

/** 既定値(学ぶ前)。自動編集の各工程の既定値と同じ */
export const DEFAULT_SHOW_STYLE: ShowStyle = {
  maxPauseSec: 0.7,
  keepPauseSec: 0.3,
  minShotSec: 2,
  maxShotSec: 8,
  sePerMinute: 6,
  bgmVolume: 0.3,
  ambienceVolume: 0.35
}

const LIMITS: Record<keyof ShowStyle, [number, number]> = {
  maxPauseSec: [0.3, 2],
  keepPauseSec: [0.1, 0.8],
  minShotSec: [0.8, 5],
  maxShotSec: [3, 20],
  sePerMinute: [0, 30],
  bgmVolume: [0.05, 1],
  ambienceVolume: [0, 1]
}

export interface LearnedStyle {
  style: ShowStyle
  /** 集計に使えた本数 */
  projects: number
  /** 項目ごとに、学べた本数(0 の項目は既定値のまま) */
  learned: Partial<Record<keyof ShowStyle, number>>
}

function quantile(values: readonly number[], q: number): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return NaN
  const pos = (v.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return v[lo] + (v[hi] - v[lo]) * (pos - lo)
}

function median(values: readonly number[]): number {
  return quantile(values, 0.5)
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}

/** 1本のプロジェクトから測れた値(測れなかった項目は無い) */
export function measureProject(project: Project): Partial<ShowStyle> {
  const out: Partial<ShowStyle> = {}
  const clips = project.clips ?? []
  const lengths = clips
    .map((c) => (c.outPoint - c.inPoint) / (c.speed || 1))
    .filter((d) => d > 0.05)
  const total = lengths.reduce((a, b) => a + b, 0)

  // 1ショットの長さ: 3本以上あるときだけ(1本だけの本編は切り替えをしていない)
  if (lengths.length >= 3) {
    out.minShotSec = quantile(lengths, 0.1)
    out.maxShotSec = quantile(lengths, 0.9)
  }

  // 間: 発言テロップ(演出テロップは除く)の終わり → 次の始まり。重なり(同時発話)は数えない
  const speech = (project.textOverlays ?? [])
    .filter((o) => !o.effectId && o.text.trim())
    .sort((a, b) => a.startTime - b.startTime)
  const gaps: number[] = []
  for (let i = 1; i < speech.length; i++) {
    const g = speech[i].startTime - speech[i - 1].endTime
    if (g > 0.02 && g < 5) gaps.push(g)
  }
  if (gaps.length >= 5) {
    out.keepPauseSec = median(gaps)
    out.maxPauseSec = quantile(gaps, 0.9)
  }

  const tracks = project.audioTracks ?? []
  const isAmbience = (t: (typeof tracks)[number]): boolean =>
    Boolean(t.multicamSourceId) && !t.voice
  const loose = tracks.filter((t) => !t.multicamSourceId && !t.voice)
  // SE: 自動の SE のトラック、または短い音(3秒未満)ばかりのトラック
  const seClips = loose
    .filter(
      (t) =>
        t.autoRole === 'se' ||
        (t.autoRole !== 'bgm' &&
          t.clips.length > 0 &&
          t.clips.every((c) => (c.outPoint - c.inPoint) / (c.speed || 1) < 3))
    )
    .reduce((n, t) => n + t.clips.length, 0)
  // SE が1つも無い回からは学ばない(使わなかったのか、書き出しに入っていないのか区別できない。
  // 0 を学ぶと、次の回から SE が一切置かれなくなる)
  if (total > 30 && seClips > 0) out.sePerMinute = seClips / (total / 60)

  // BGM: 自動の BGM のトラック、または長い音(20秒以上)のあるトラック。音量はトラック × クリップ
  const bgm = loose
    .filter(
      (t) =>
        t.autoRole === 'bgm' ||
        (t.autoRole !== 'se' &&
          t.clips.some((c) => (c.outPoint - c.inPoint) / (c.speed || 1) >= 20))
    )
    .flatMap((t) => t.clips.map((c) => t.volume * (c.volume ?? 1)))
  if (bgm.length > 0) out.bgmVolume = median(bgm)

  const amb = tracks.filter(isAmbience).map((t) => t.volume)
  if (amb.length > 0) out.ambienceVolume = median(amb)
  return out
}

/** 過去回の集計(本どうしは中央値)。学べなかった項目は既定値のまま */
export function learnShowStyle(projects: readonly Project[]): LearnedStyle {
  const measured = projects.map(measureProject)
  const style: ShowStyle = { ...DEFAULT_SHOW_STYLE }
  const learned: LearnedStyle['learned'] = {}
  for (const key of Object.keys(DEFAULT_SHOW_STYLE) as (keyof ShowStyle)[]) {
    const values = measured.map((m) => m[key]).filter((v): v is number => Number.isFinite(v))
    if (values.length === 0) continue
    const [lo, hi] = LIMITS[key]
    style[key] = round2(Math.min(hi, Math.max(lo, median(values))))
    learned[key] = values.length
  }
  // 最短 < 最長、残す間 < 詰める間 を保つ
  if (style.maxShotSec < style.minShotSec + 1) style.maxShotSec = round2(style.minShotSec + 1)
  if (style.keepPauseSec >= style.maxPauseSec)
    style.keepPauseSec = round2(Math.max(LIMITS.keepPauseSec[0], style.maxPauseSec * 0.5))
  return { style, projects: projects.length, learned }
}

/** 保存していた値を読み直す(壊れた項目は既定値) */
export function normalizeShowStyle(raw: unknown): ShowStyle {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const style: ShowStyle = { ...DEFAULT_SHOW_STYLE }
  for (const key of Object.keys(DEFAULT_SHOW_STYLE) as (keyof ShowStyle)[]) {
    const v = r[key]
    const [lo, hi] = LIMITS[key]
    if (typeof v === 'number' && Number.isFinite(v)) style[key] = Math.min(hi, Math.max(lo, v))
  }
  return style
}

/** 画面に出す要約 */
export function describeShowStyle(s: ShowStyle): string {
  return [
    `間 ${s.maxPauseSec}秒を超えたら ${s.keepPauseSec}秒に詰める`,
    `1ショット ${s.minShotSec}〜${s.maxShotSec}秒`,
    `SE 1分に ${s.sePerMinute} 個まで`,
    `BGM ${Math.round(s.bgmVolume * 100)}%`,
    `周りの音 ${Math.round(s.ambienceVolume * 100)}%`
  ].join(' · ')
}

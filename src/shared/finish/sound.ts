import type { EffectKind } from '../telop/effects'

/**
 * SE・BGM の自動配置(計画書 §5.9)。
 *
 * 素材は利用者の「番組素材フォルダ」から選ぶ。フォルダ名がそのまま分類になる:
 *   SE/ツッコミ/…  SE/心の声/…  SE/状況/…  SE/地名/…  SE/コーナー/…  SE/場面転換/…
 *   BGM/楽しい/…   BGM/穏やか/…  BGM/緊張/…  BGM/感動/…  BGM/移動/…
 * 同じ音が続かないよう、分類の中で順番に使う。
 */

export const SE_CATEGORIES = ['ツッコミ', '心の声', '状況', '地名', 'コーナー', '場面転換'] as const
export type SeCategory = (typeof SE_CATEGORIES)[number]

export const BGM_MOODS = ['楽しい', '穏やか', '緊張', '感動', '移動'] as const
export type BgmMood = (typeof BGM_MOODS)[number]

/** 演出テロップの種類 → SE の分類 */
export const SE_FOR_EFFECT: Record<EffectKind, SeCategory> = {
  tsukkomi: 'ツッコミ',
  kokoro: '心の声',
  situation: '状況',
  place: '地名',
  corner: 'コーナー'
}

/** フォルダ名の言い換え(英語・よくある別名)。比べるときは小文字・空白なしで */
const ALIASES: Record<string, string> = {
  tsukkomi: 'ツッコミ',
  つっこみ: 'ツッコミ',
  突っ込み: 'ツッコミ',
  inner: '心の声',
  kokoro: '心の声',
  situation: '状況',
  状況説明: '状況',
  place: '地名',
  地名・情報: '地名',
  corner: 'コーナー',
  コーナー名: 'コーナー',
  transition: '場面転換',
  転換: '場面転換',
  fun: '楽しい',
  happy: '楽しい',
  calm: '穏やか',
  tense: '緊張',
  emotional: '感動',
  travel: '移動',
  move: '移動'
}

/** フォルダ名を分類名に揃える(分からなければそのまま) */
export function normalizeCategory(folder: string): string {
  const key = folder.trim().replace(/\s+/g, '').toLowerCase()
  return ALIASES[key] ?? folder.trim()
}

export interface KitFile {
  path: string
  name: string
  /** 秒 */
  duration: number
}

/** 番組素材フォルダの中身(分類 → ファイル) */
export interface ShowKit {
  se: Record<string, KitFile[]>
  bgm: Record<string, KitFile[]>
  cg: Record<string, KitFile[]>
}

export interface PlacedSound {
  path: string
  /** タイムラインの秒 */
  startTime: number
  /** 素材の秒 */
  inPoint: number
  outPoint: number
  volume: number
  fadeIn?: number
  fadeOut?: number
  /** 何に合わせて置いたか(画面のログ用) */
  reason: string
}

/** 分類の中で順番に使う(同じ音が続かない) */
class Rotation {
  private next = new Map<string, number>()
  pick(files: readonly KitFile[] | undefined, key: string): KitFile | null {
    if (!files || files.length === 0) return null
    const i = this.next.get(key) ?? 0
    this.next.set(key, i + 1)
    return files[i % files.length]
  }
}

export const SE_VOLUME = 0.8
/** 同じ時刻付近に SE を重ねない(秒) */
const SE_MIN_GAP = 0.6

/**
 * SE を置く。演出テロップの出だしに種類の SE、場面の変わり目に場面転換の SE。
 * 近すぎるもの(0.6秒以内)は先のものだけ残す。
 */
export function planSoundEffects(
  effects: readonly { time: number; kind: EffectKind; text: string }[],
  sceneStarts: readonly number[],
  kit: ShowKit
): PlacedSound[] {
  const rot = new Rotation()
  const out: PlacedSound[] = []
  const wants = [
    ...effects.map((e) => ({
      time: e.time,
      category: SE_FOR_EFFECT[e.kind] as string,
      reason: `${SE_FOR_EFFECT[e.kind]}「${e.text.slice(0, 12)}」`
    })),
    // 最初の場面の頭(0秒)には置かない
    ...sceneStarts
      .filter((t) => t > 0.5)
      .map((t) => ({ time: t, category: '場面転換', reason: '場面転換' }))
  ].sort((a, b) => a.time - b.time)
  for (const w of wants) {
    const last = out[out.length - 1]
    if (last && w.time - last.startTime < SE_MIN_GAP) continue
    const file = rot.pick(kit.se[w.category], w.category)
    if (!file || !(file.duration > 0)) continue
    out.push({
      path: file.path,
      startTime: Math.max(0, w.time),
      inPoint: 0,
      outPoint: file.duration,
      volume: SE_VOLUME,
      reason: w.reason
    })
  }
  return out
}

export const BGM_VOLUME = 0.3
const BGM_FADE = 1.5

/** 場面の判定から雰囲気を決める(AI の雰囲気が無いとき) */
export function fallbackMood(kind: 'highlight' | 'normal' | 'unneeded'): BgmMood {
  return kind === 'highlight' ? '楽しい' : '穏やか'
}

/**
 * BGM を置く。続けて同じ雰囲気の場面は1曲で通し、雰囲気が変わる所で曲を替える(前後はフェード)。
 * 曲が場面より短ければ、同じ曲を繰り返す(継ぎ目もフェード)。
 */
export function planBgm(
  scenes: readonly { start: number; end: number; mood: BgmMood }[],
  kit: ShowKit
): PlacedSound[] {
  const rot = new Rotation()
  const out: PlacedSound[] = []
  // 同じ雰囲気が続く場面はまとめる
  const runs: { start: number; end: number; mood: BgmMood }[] = []
  for (const s of [...scenes].sort((a, b) => a.start - b.start)) {
    const last = runs[runs.length - 1]
    if (last && last.mood === s.mood && s.start - last.end < 1) last.end = Math.max(last.end, s.end)
    else runs.push({ ...s })
  }
  for (const r of runs) {
    const file = rot.pick(kit.bgm[r.mood], r.mood)
    if (!file || !(file.duration > 2)) continue
    let t = r.start
    while (t < r.end - 0.5) {
      const len = Math.min(file.duration, r.end - t)
      out.push({
        path: file.path,
        startTime: t,
        inPoint: 0,
        outPoint: len,
        volume: BGM_VOLUME,
        fadeIn: Math.min(BGM_FADE, len / 3),
        fadeOut: Math.min(BGM_FADE, len / 3),
        reason: `${r.mood}(${file.name})`
      })
      t += len
    }
  }
  return out
}

/** 共通の時刻の区間 → 仮編集のタイムラインの区間(残っている部分の最初〜最後) */
export function timelineRangeOf(
  spans: readonly { timeline: number; start: number; end: number }[],
  start: number,
  end: number
): { start: number; end: number } | null {
  let lo = Infinity
  let hi = -Infinity
  for (const s of spans) {
    const a = Math.max(start, s.start)
    const b = Math.min(end, s.end)
    if (b <= a) continue
    lo = Math.min(lo, s.timeline + (a - s.start))
    hi = Math.max(hi, s.timeline + (b - s.start))
  }
  return lo < hi ? { start: lo, end: hi } : null
}

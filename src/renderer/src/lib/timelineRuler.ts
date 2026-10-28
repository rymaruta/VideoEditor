/**
 * タイムラインの時間目盛り(上端のルーラー)。Premiere と同じ `時:分:秒:フレーム` で出す。
 *
 * 目盛りの間隔はズームに合わせて選ぶ(数字同士が重ならない最小の間隔)。描くのは見えている
 * 範囲だけ(長尺でも目盛りの数が一定になるように)。
 */

/** 選べる間隔(秒)。1フレーム単位は fps から足す */
const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/** 目盛りの数字同士の最小の間隔(画素) */
export const RULER_MIN_SPACING_PX = 90

export function rulerStep(
  pixelsPerSecond: number,
  fps: number,
  minSpacingPx = RULER_MIN_SPACING_PX
): number {
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return 3600
  const frame = Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 30
  const candidates = [frame, frame * 5, frame * 10, ...STEPS]
  return candidates.find((s) => s * pixelsPerSecond >= minSpacingPx) ?? STEPS[STEPS.length - 1]
}

/** 数字(HH:MM:SS:FF)同士の最小の間隔(画素)。11px の等幅で 11 字 + 余白 */
export const RULER_LABEL_SPACING_PX = 110

/** 数字の間隔ごとの、中の目盛りと細かい目盛りの間隔(秒)。30 秒なら 10 秒と 2 秒(デザイン案の 3 段) */
const TIERS: Record<number, [mid: number, minor: number]> = {
  1: [0.5, 0.1],
  2: [1, 0.5],
  5: [1, 0.5],
  10: [5, 1],
  15: [5, 1],
  30: [10, 2],
  60: [30, 10],
  120: [60, 10],
  300: [60, 10],
  600: [300, 60],
  900: [300, 60],
  1800: [600, 120],
  3600: [1800, 600]
}

/** 中の目盛りが詰まりすぎない最小の間隔(画素)・細かい目盛りの最小の間隔(画素) */
const MID_MIN_PX = 12
const MINOR_MIN_PX = 4

/**
 * 目盛りの 3 段(数字の付く目盛り・中の目盛り・細かい目盛り)の間隔(秒)。拡大に合わせて間隔を変える。
 * 中・細かい目盛りは、詰まりすぎる(画素が足りない)ときや 1 コマより細かいときは出さない(null)
 */
export function rulerTiers(
  pixelsPerSecond: number,
  fps: number
): { label: number; mid: number | null; minor: number | null } {
  const label = rulerStep(pixelsPerSecond, fps, RULER_LABEL_SPACING_PX)
  const frame = Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 30
  const tier = TIERS[label]
  const fits = (step: number | null, minPx: number): number | null =>
    step !== null && step >= frame - 1e-9 && step * pixelsPerSecond >= minPx ? step : null
  if (!tier) {
    // 1 秒より細かい数字の間隔: 1 コマごとの細かい目盛りだけ
    return { label, mid: null, minor: label > frame + 1e-9 ? fits(frame, MINOR_MIN_PX) : null }
  }
  return { label, mid: fits(tier[0], MID_MIN_PX), minor: fits(tier[1], MINOR_MIN_PX) }
}

/** [from, to] 秒に入る目盛りの時刻(間隔の整数倍)。数が多すぎるときは打ち切る */
export function rulerTicks(from: number, to: number, step: number, max = 400): number[] {
  if (!(step > 0) || !Number.isFinite(from) || !Number.isFinite(to) || to < from) return []
  const out: number[] = []
  const first = Math.max(0, Math.ceil(from / step - 1e-9))
  for (let i = first; i * step <= to + 1e-9 && out.length < max; i++) out.push(i * step)
  return out
}

/**
 * `時:分:秒:フレーム`。負や数でない値は 0 として扱う。
 * `fps` は本当のフレームレート(29.97 なら 30000/1001)。29.97 / 59.94 はドロップフレーム
 * (`時:分:秒;フレーム`。毎分の頭の 2 / 4 コマの番号を飛ばし、10 分ごとには飛ばさない)で数え、
 * 時刻表示が実時間とずれないようにする。整数に丸めて数えると、29.97 で約 1000 コマごとに
 * フレームの番号が1つ飛び、10 分の所が 00:10:00 にならなかった。
 * 23.976 などドロップしない NTSC のレートは、本当のコマを 24 進で数える(番号は飛ばさない)
 */
export function formatTimecode(seconds: number, fps: number): string {
  const real = Number.isFinite(fps) && fps > 0 ? fps : 30
  const nominal = Math.round(real)
  // 99時間で頭打ちにする(壊れた値で表示が Infinity にならないように)
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 99 * 3600) : 0
  const pad = (n: number): string => String(n).padStart(2, '0')
  // ドロップフレームは NTSC の 29.97 / 59.94 だけ(30.3 などの半端なレートは、今までどおり
  // 丸めたレートで実時間から数える)
  const ntsc = Math.abs(real - (nominal * 1000) / 1001) < 0.01
  const dropFrame = (nominal === 30 || nominal === 60) && ntsc
  // 23.976 などの NTSC の半端なレート(ドロップしないもの)も、本当のコマ数で数えて番号は 24 進で振る
  // (丸めたレートで実時間から数えると、約 1000 コマごとに番号が1つ飛んでいた)
  let frame = Math.round(safe * (ntsc ? real : nominal))
  if (dropFrame) {
    const drop = nominal === 30 ? 2 : 4
    const per10 = nominal * 600 - drop * 9
    const perMin = nominal * 60 - drop
    const d = Math.floor(frame / per10)
    const m = frame % per10
    frame += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / perMin) : 0)
  }
  const f = frame % nominal
  const s = Math.floor(frame / nominal)
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}${dropFrame ? ';' : ':'}${pad(f)}`
}

/**
 * `formatTimecode` の逆。`時:分:秒:フレーム`(区切りは `:` か `;`)を秒にする。
 * 後ろから詰めて読む(`12:05` は 12 秒 5 フレーム、`1:00:00` は 1 分)。`.` を含む数は秒(`12.5` は 12.5 秒)。区切りの無い数字だけなら
 * `時分秒フレーム` を右から 2 桁ずつ読む(Premiere と同じ。`100` は 1 秒、`10000` は 1 分)。
 * 読めない・範囲の外(分・秒が 60 以上・フレームがレート以上)は null。
 * 29.97 / 59.94 はドロップフレームの番号として読む(`formatTimecode` と行って戻って同じ時刻)。
 * 飛ばした番号(毎分の頭の `;00`・`;01` など)は、次の有効な番号として読む
 */
export function parseTimecode(text: string, fps: number): number | null {
  const real = Number.isFinite(fps) && fps > 0 ? fps : 30
  const nominal = Math.round(real)
  const raw = text.trim()
  if (!raw) return null
  // `.` を含む数は秒(小数)として読む(`12.5` は 12.5 秒)
  if (/^\d*\.\d+$|^\d+\.$/.test(raw)) {
    const sec = Number(raw)
    return Number.isFinite(sec) && sec <= 99 * 3600 ? sec : null
  }
  let parts: number[]
  if (/^\d+$/.test(raw)) {
    if (raw.length > 8) return null
    const padded = raw.padStart(Math.ceil(raw.length / 2) * 2, '0')
    parts = (padded.match(/\d{2}/g) ?? []).map(Number)
  } else {
    if (!/^\d{1,2}([:;]\d{1,2}){0,3}$/.test(raw)) return null
    parts = raw.split(/[:;]/).map(Number)
  }
  if (parts.length === 0 || parts.length > 4) return null
  const [f0, s = 0, m = 0, h = 0] = [...parts].reverse()
  let f = f0
  if (f >= nominal || s >= 60 || m >= 60) return null
  const ntsc = Math.abs(real - (nominal * 1000) / 1001) < 0.01
  const dropFrame = (nominal === 30 || nominal === 60) && ntsc
  let frame = ((h * 60 + m) * 60 + s) * nominal + f
  if (dropFrame) {
    const drop = nominal === 30 ? 2 : 4
    const minutes = h * 60 + m
    // 毎分の頭の飛ばした番号(10 分ごとを除く)は、次の有効な番号として読む
    if (s === 0 && f < drop && m % 10 !== 0) {
      f = drop
      frame = ((h * 60 + m) * 60 + s) * nominal + f
    }
    frame -= drop * (minutes - Math.floor(minutes / 10))
  }
  return frame / (ntsc ? real : nominal)
}

/** 素材の格子の長さの札: M:SS(1 時間を超えたら H:MM:SS)。秒より細かい時刻は札の title と一覧で */
export function formatShortDuration(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * タイムコードの入力欄で Enter を押したときに決める値。開いたときの表示のまま(打ち変えていない)なら
 * 'unchanged'(決めない・取り消しの履歴にも積まない)、読めなければ null、読めれば min〜max に収めた秒
 */
export function timecodeEntryValue(
  draft: string,
  opened: string,
  fps: number,
  min: number,
  max?: number
): number | null | 'unchanged' {
  if (draft.trim() === opened.trim()) return 'unchanged'
  const t = parseTimecode(draft, fps)
  if (t === null) return null
  return Math.max(min, max === undefined ? t : Math.min(max, t))
}

/**
 * 長さを「7:22」(1 時間を超えたら「1:07:22」)の形で。編集画面の時刻(`formatTimecode`)と書き出し
 * (フレーム数)と同じく、まずコマに丸めてから秒の端数を切り捨てる。確認の画面は秒を切り捨て、書き出しの
 * 画面は秒を四捨五入していて、441.98 秒の仕上がりが確認の画面だけ 7:21(編集画面・書き出しは 7:22)だった
 */
export function lengthClock(seconds: number, fps: number): string {
  const real = Number.isFinite(fps) && fps > 0 ? fps : 30
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 99 * 3600) : 0
  const frames = Math.round(safe * real)
  const v = Math.floor(frames / real + 1e-9)
  const h = Math.floor(v / 3600)
  const m = Math.floor((v % 3600) / 60)
  const ss = String(v % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

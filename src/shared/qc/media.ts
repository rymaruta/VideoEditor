import { LOUDNESS_TARGETS, normalizeLoudnessTarget, type LoudnessTarget } from '../loudness'
import type { QcIssue } from './types'

/**
 * 書き出した動画の自動確認(計画書 §5.12)のうち、映像と音声を測る部分。
 *
 * ffmpeg を1回だけ通し(`QC_FILTER`)、ログから次を拾う:
 * - 黒味(`blackdetect`)・フリーズ(`freezedetect`)— 映像は縮めてから測る(速さのため。判定は変わらない)
 * - 無音(`silencedetect`)・ラウドネスとトゥルーピーク(`ebur128`)
 */

export interface Span {
  start: number
  end: number
}

export interface QcMeasurement {
  black: Span[]
  freeze: Span[]
  silence: Span[]
  loudness: { integrated: number; lra: number; truePeak: number } | null
  /** 読み終えた位置(秒)。最後まで読めたかの確認と、閉じていない区間を閉じるのに使う */
  duration: number
}

/** 黒味: 0.5秒以上。フリーズ: 2秒以上。無音: -50dB 未満が2秒以上 */
export const QC_THRESHOLDS = {
  blackMinSec: 0.5,
  blackPixel: 0.1,
  freezeMinSec: 2,
  freezeNoise: 0.003,
  silenceDb: -50,
  silenceMinSec: 2,
  /** ラウドネスの許容差(LU) */
  loudnessTolerance: 1,
  /** トゥルーピークの余裕(基準の上限からこれ以上超えたら知らせる) */
  truePeakTolerance: 0.5
} as const

/**
 * 映像が無い・音声が無い書き出しもあるので、映像と音声の枝はそれぞれ付け外しする。
 *
 * `duration`(ファイル全体の長さ)を渡すと、先に尽きた映像・音声を全体の長さまで延ばしてから測る。
 * 映像だけ・音声だけが途中で終わった書き出しは、無い所に測るものが無いので素通りしていた
 * (プレイヤーは最後の1枚のまま止まる・音が途切れる)。映像は最後の1枚を写して延ばす(フリーズになる)、
 * 音声は無音で延ばす(無音になる)
 */
export function qcFilter(hasVideo: boolean, hasAudio: boolean, duration?: number): string {
  const t = QC_THRESHOLDS
  const parts: string[] = []
  const d = duration !== undefined && duration > 0 ? duration.toFixed(3) : null
  if (hasVideo)
    parts.push(
      `[0:v]${d ? `tpad=stop_mode=clone:stop_duration=${d},trim=end=${d},` : ''}` +
        `scale=320:-2,blackdetect=d=${t.blackMinSec}:pix_th=${t.blackPixel},` +
        `freezedetect=n=${t.freezeNoise}:d=${t.freezeMinSec}[qv]`
    )
  if (hasAudio)
    parts.push(
      `[0:a]${d ? `apad=whole_dur=${d},` : ''}ebur128=peak=true:framelog=quiet,` +
        `silencedetect=noise=${t.silenceDb}dB:d=${t.silenceMinSec}[qa]`
    )
  return parts.join(';')
}

const num = (s: string | undefined): number => (s === undefined ? NaN : Number(s))

/**
 * ffmpeg のログを1行ずつ読む。長尺でも行を貯めない(必要な値だけ持つ)。
 */
export class QcLogParser {
  private black: Span[] = []
  private freeze: Span[] = []
  private silence: Span[] = []
  private freezeStart: number | null = null
  private silenceStart: number | null = null
  private inSummary = false
  private integrated = NaN
  private lra = NaN
  private truePeak = NaN
  private lastTime = 0

  push(line: string): void {
    let m = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/.exec(line)
    if (m) {
      this.black.push({ start: num(m[1]), end: num(m[2]) })
      return
    }
    m = /freezedetect\.freeze_start:\s*([\d.]+)/.exec(line)
    if (m) {
      this.freezeStart = num(m[1])
      return
    }
    m = /freezedetect\.freeze_end:\s*([\d.]+)/.exec(line)
    if (m) {
      if (this.freezeStart !== null) this.freeze.push({ start: this.freezeStart, end: num(m[1]) })
      this.freezeStart = null
      return
    }
    m = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (m) {
      this.silenceStart = Math.max(0, num(m[1]))
      return
    }
    m = /silence_end:\s*([\d.]+)/.exec(line)
    if (m) {
      if (this.silenceStart !== null)
        this.silence.push({ start: this.silenceStart, end: num(m[1]) })
      this.silenceStart = null
      return
    }
    m = /\btime=(\d+):(\d+):([\d.]+)/.exec(line)
    if (m) {
      this.lastTime = num(m[1]) * 3600 + num(m[2]) * 60 + num(m[3])
      return
    }
    if (/ebur128.*Summary:/.test(line)) {
      this.inSummary = true
      return
    }
    if (!this.inSummary) return
    m = /^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(line)
    if (m) this.integrated = m[1] === '-inf' ? -Infinity : num(m[1])
    m = /^\s*LRA:\s*([\d.]+)\s*LU/.exec(line)
    if (m) this.lra = num(m[1])
    m = /^\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(line)
    if (m) this.truePeak = m[1] === '-inf' ? -Infinity : num(m[1])
  }

  /** `duration`: 動画の長さ(分かれば)。閉じていない無音・フリーズはそこで閉じる */
  result(duration?: number): QcMeasurement {
    const end = duration && duration > 0 ? duration : this.lastTime
    const freeze = [...this.freeze]
    if (this.freezeStart !== null) freeze.push({ start: this.freezeStart, end })
    const silence = [...this.silence]
    if (this.silenceStart !== null) silence.push({ start: this.silenceStart, end })
    return {
      black: this.black,
      freeze: mergeTouching(freeze),
      silence,
      loudness: Number.isNaN(this.integrated)
        ? null
        : { integrated: this.integrated, lra: this.lra, truePeak: this.truePeak },
      duration: end
    }
  }
}

/**
 * つながった区間を1つにする。freezedetect は画の一部(テロップの出入りなど)が変わるたびに
 * 区間を切るので、続けて止まっている区間がばらばらに出る。
 */
export function mergeTouching(spans: readonly Span[], gap = 0.05): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end + gap) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** 区間 `a` から `cuts` を差し引いた残り */
export function subtract(a: Span, cuts: readonly Span[]): Span[] {
  let pieces: Span[] = [{ ...a }]
  for (const c of cuts)
    pieces = pieces.flatMap((p) =>
      c.end <= p.start || c.start >= p.end
        ? [p]
        : [
            ...(c.start > p.start ? [{ start: p.start, end: c.start }] : []),
            ...(c.end < p.end ? [{ start: c.end, end: p.end }] : [])
          ]
    )
  return pieces
}

function fmt(sec: number): string {
  return `${sec.toFixed(1)}秒`
}

/** 測った値を、知らせる項目にする */
export function mediaIssues(m: QcMeasurement, target: LoudnessTarget | 'off'): QcIssue[] {
  const issues: QcIssue[] = []
  m.black.forEach((s, i) =>
    issues.push({
      id: `black-${i}`,
      kind: 'black',
      severity: 'error',
      start: s.start,
      end: s.end,
      message: `黒い画面が ${fmt(s.end - s.start)} 続いています`
    })
  )
  // 黒味は画も止まっているので、フリーズとしても出る(続く静止画とつながって1つになることもある)。
  // 黒味として知らせたぶんを差し引き、残りが短ければ知らせない
  const freezes = m.freeze
    .flatMap((f) => subtract(f, m.black))
    .filter((f) => f.end - f.start >= QC_THRESHOLDS.freezeMinSec)
  freezes.forEach((s, i) =>
    issues.push({
      id: `freeze-${i}`,
      kind: 'freeze',
      severity: 'warn',
      start: s.start,
      end: s.end,
      message: `画が ${fmt(s.end - s.start)} 止まっています(静止画・素材の欠けでないか)`
    })
  )
  m.silence.forEach((s, i) =>
    issues.push({
      id: `silence-${i}`,
      kind: 'silence',
      severity: 'warn',
      start: s.start,
      end: s.end,
      message: `音が ${fmt(s.end - s.start)} 途切れています`
    })
  )
  if (m.loudness && target !== 'off') {
    const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
    const { integrated, truePeak } = m.loudness
    if (!(Math.abs(integrated - t.integrated) <= QC_THRESHOLDS.loudnessTolerance))
      issues.push({
        id: 'loudness',
        kind: 'loudness',
        severity: 'error',
        start: 0,
        end: m.duration,
        message: `全体の音量が ${Number.isFinite(integrated) ? integrated.toFixed(1) : '−∞'} LUFS です(基準 ${t.label})`
      })
    if (truePeak > t.truePeak + QC_THRESHOLDS.truePeakTolerance)
      issues.push({
        id: 'truePeak',
        kind: 'truePeak',
        severity: 'error',
        start: 0,
        end: m.duration,
        message: `音の最大値(トゥルーピーク)が ${truePeak.toFixed(1)} dBTP です(上限 ${t.truePeak} dBTP)`
      })
  }
  return issues
}

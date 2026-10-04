import type { AudioEventWindow } from '../events/audioEvents'
import type { Scene, SceneJudgement } from '../structure/scenes'
import { fileAt, toSource, type MulticamInfo } from '../sync/multicam'
import { AUTO_PLACE_CONFIDENCE, type EffectLine, type EffectProposal } from './effects'

/**
 * AI を使わずに決まる演出テロップの提案: 笑いの添え字・章タイトル・時刻・吹き出し。
 * 人物紹介(`nameProposals`)と同じく、AI を使わない設定でも出す。
 * 時刻は共通の時刻(`at`)で持ち、仮編集に残った所にだけ置かれる。
 */

/** 添え字を出す笑いの強さ。検出の閾値(0.04)より上の、はっきり笑った所だけ */
export const LAUGH_MARK_MIN = 0.15
/** これ以上なら「一同爆笑」 */
export const LAUGH_BIG = 0.3
/** 笑いの添え字どうしの間隔(秒)。多いとうるさい */
export const LAUGH_MIN_GAP_SEC = 45

export function laughProposals(events: readonly AudioEventWindow[]): EffectProposal[] {
  const out: EffectProposal[] = []
  let last = -Infinity
  // 続けて超えた窓は1回の笑いにまとめ、いちばん強い窓の真ん中に出す
  let run: AudioEventWindow[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const peak = run.reduce((m, e) => (e.laugh > m.laugh ? e : m))
    run = []
    const at = (peak.start + peak.end) / 2
    if (at - last < LAUGH_MIN_GAP_SEC) return
    last = at
    const big = peak.laugh >= LAUGH_BIG
    out.push({
      id: `laugh-${Math.round(at * 10)}`,
      afterLineId: '',
      at,
      kind: 'laugh',
      text: big ? '(一同爆笑)' : '(笑)',
      confidence: big ? 0.9 : 0.6,
      reason: `笑い声を検出(${Math.round(peak.laugh * 100)}%)`
    })
  }
  for (const e of [...events].sort((a, b) => a.start - b.start)) {
    if (e.laugh < LAUGH_MARK_MIN) {
      flush()
      continue
    }
    const prev = run[run.length - 1]
    if (prev && e.start > prev.end) flush()
    run.push(e)
  }
  flush()
  return out
}

/** 前の場面からこれ以上時間が飛んでいたら、別の場所・別の企画とみなして章を分ける(秒) */
export const CHAPTER_GAP_SEC = 120
/** 章の最低の長さ(秒)。短い章が続くと見出しばかりになる */
export const CHAPTER_MIN_SEC = 240

/**
 * 章タイトル。残した場面のうち、前の場面から時間が大きく飛んだ所(移動・次の企画)を章の頭にし、
 * その場面の見出し(AI が付けたもの)を出す。見出しが無ければ出さない。
 */
export function chapterProposals(
  scenes: readonly Scene[],
  judgements: readonly SceneJudgement[],
  keptIds: readonly string[]
): EffectProposal[] {
  const kept = new Set(keptIds)
  const title = new Map(judgements.map((j) => [j.sceneId, j.title?.trim()]))
  const list = scenes.filter((s) => kept.has(s.id)).sort((a, b) => a.start - b.start)
  const out: EffectProposal[] = []
  let prevEnd = -Infinity
  let chapterStart = -Infinity
  for (const s of list) {
    const jump = s.start - prevEnd
    prevEnd = s.end
    const head = title.get(s.id)
    if (!head) continue
    const first = out.length === 0
    if (!first && (jump < CHAPTER_GAP_SEC || s.start - chapterStart < CHAPTER_MIN_SEC)) continue
    chapterStart = s.start
    out.push({
      id: `chapter-${s.id}`,
      afterLineId: '',
      at: s.start + 0.3,
      kind: 'chapter',
      text: `第${out.length + 1}章\n${head}`,
      confidence: AUTO_PLACE_CONFIDENCE,
      reason: first ? '最初の場面' : `前の場面から ${Math.round(jump / 60)} 分飛んでいる`
    })
  }
  // 章が1つだけなら章立ての意味が無い
  return out.length >= 2 ? out : []
}

/** 撮影時刻(ms)を「AM 10:32」の形に(このPCの時刻帯で) */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h < 12 ? 'AM' : 'PM'} ${h % 12 === 0 ? 12 : h % 12}:${m}`
}

/**
 * 時刻スーパー。章の頭(無ければ最初の場面)に、その時刻の撮影時刻を出す。
 * カメラの時計は合っていないことが多いので、自動では置かず提案にする(人が確かめて選ぶ)
 */
export function clockProposals(
  times: readonly number[],
  info: MulticamInfo,
  recordedAt: ReadonlyMap<string, number>
): EffectProposal[] {
  const out: EffectProposal[] = []
  const sources = [
    info.anchorSourceId,
    ...info.sources.filter((s) => s.id !== info.anchorSourceId).map((s) => s.id)
  ]
  for (const t of times) {
    let clock: number | null = null
    for (const src of sources) {
      const f = fileAt(info, src, t)
      const base = f ? recordedAt.get(f.assetId) : undefined
      if (f && base !== undefined) {
        clock = base + toSource(f, t) * 1000
        break
      }
    }
    if (clock === null) continue
    out.push({
      id: `clock-${Math.round(t * 10)}`,
      afterLineId: '',
      at: t + 0.3,
      kind: 'clock',
      text: formatClock(clock),
      confidence: 0.6,
      reason: '撮影時刻(カメラの時計。合っているか確かめてください)'
    })
  }
  return out
}

/** 吹き出しにする発言の長さの上限(文字) */
export const BUBBLE_MAX_CHARS = 8

/**
 * 吹き出し。短い驚き・問いかけの発言を、発言テロップの代わりに吹き出しで出す提案。
 * 顔の横に置くかは画による(置き場所は人が決める)ので、自動では置かない
 */
export function bubbleProposals(lines: readonly EffectLine[]): EffectProposal[] {
  const out: EffectProposal[] = []
  for (const l of lines) {
    const text = l.text.trim().replace(/[。、]$/u, '')
    const chars = [...text.replace(/\s/g, '')].length
    if (chars === 0 || chars > BUBBLE_MAX_CHARS) continue
    if (!/[!?！？]$/u.test(text)) continue
    out.push({
      id: `bubble-${l.id}`,
      afterLineId: l.id,
      kind: 'bubble',
      text,
      confidence: 0.5,
      reason: '短い驚き・問いかけ'
    })
  }
  return out
}

import type { TextStyle } from '../types'
import { defaultTextStyle } from '../textStyle'

/**
 * 演出テロップ(計画書 §5.8): ツッコミ・心の声・状況説明・地名・コーナー名。
 *
 * AI(Gemini)が、発言の流れを読んで「どの発言の後に・どの種類で・何と出すか・自信度」を提案する。
 * 自信の高いもの(`AUTO_PLACE_CONFIDENCE` 以上)だけを自動で置き、残りは提案として人が選ぶ。
 * 送るのは話者つきの文字起こしだけ。発言そのものを書き換える提案は受け付けない(演出の文だけ)。
 */

export type EffectKind = 'tsukkomi' | 'kokoro' | 'situation' | 'place' | 'corner'

export const EFFECT_LABEL: Record<EffectKind, string> = {
  tsukkomi: 'ツッコミ',
  kokoro: '心の声',
  situation: '状況説明',
  place: '地名・情報',
  corner: 'コーナー名'
}

export const AUTO_PLACE_CONFIDENCE = 0.8
const MAX_TEXT_CHARS = 20

export interface EffectLine {
  id: string
  speaker?: string
  text: string
  /** 時刻(秒、表示用) */
  start: number
}

export interface EffectProposal {
  id: string
  /** この発言の後に出す */
  afterLineId: string
  kind: EffectKind
  text: string
  confidence: number
  reason: string
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function buildEffectPrompt(
  lines: readonly EffectLine[],
  episodeName: string,
  note?: string
): string {
  const list = lines
    .map((l) => `[${l.id}] ${clock(l.start)} ${l.speaker ?? '?'}「${l.text}」`)
    .join('\n')
  return `あなたはテレビのバラエティ番組(ロケ番組)のテロップ担当です。
番組「${episodeName}」の発言の流れを読み、演出テロップを提案してください。
${note ? `方針: ${note}\n` : ''}
種類:
- tsukkomi: ツッコミ(発言へのひとこと。例「いや早すぎ!」)
- kokoro: 心の声(話者の内心。例「(帰りたい…)」)
- situation: 状況説明(例「ここまで歩いて40分」)
- place: 地名・情報(発言に出てきた地名や店名。例「浄土ヶ浜」)
- corner: コーナー名(企画の区切り)
決まり:
- 1つの文は${MAX_TEXT_CHARS}字以内。発言を書き換えたり、言っていない事実を作ったりしない
- 地名・状況説明は、発言の中に根拠があるものだけ
- 多すぎると邪魔なので、本当に効くものだけ(目安: 1分に1つまで)
- confidence: 0〜1(番組でそのまま使えると思う確からしさ)

発言:
${list}

次の JSON だけを返してください:
{"effects":[{"after":"発言のID","kind":"tsukkomi","text":"","confidence":0.0,"reason":"理由(日本語1文)"}]}`
}

const KINDS = Object.keys(EFFECT_LABEL) as EffectKind[]

export function parseEffectAnswer(answer: unknown, lines: readonly EffectLine[]): EffectProposal[] {
  const ids = new Set(lines.map((l) => l.id))
  const list =
    answer && typeof answer === 'object' && Array.isArray((answer as { effects?: unknown }).effects)
      ? ((answer as { effects: unknown[] }).effects as unknown[])
      : []
  const out: EffectProposal[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const after = typeof o.after === 'string' ? o.after : ''
    const kind = KINDS.find((k) => k === o.kind)
    const text = typeof o.text === 'string' ? o.text.trim() : ''
    const confidence =
      typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? o.confidence : NaN
    if (
      !ids.has(after) ||
      !kind ||
      !text ||
      [...text].length > MAX_TEXT_CHARS ||
      Number.isNaN(confidence)
    )
      continue
    out.push({
      id: `fx-${after}-${out.length}`,
      afterLineId: after,
      kind,
      text,
      confidence: Math.max(0, Math.min(1, confidence)),
      reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 200) : ''
    })
  }
  return out
}

/** 種類ごとの見た目(テロップスタイルの管理で「演出・○○」を作れば、そちらが優先される) */
export function effectStyle(kind: EffectKind): TextStyle {
  const base = defaultTextStyle()
  switch (kind) {
    case 'tsukkomi':
      return {
        ...base,
        position: 'center',
        fontSize: 64,
        color: '#ffe14d',
        outline: true,
        outlineColor: '#7a2a00',
        outlineWidth: 6,
        bold: true,
        animation: 'popIn'
      }
    case 'kokoro':
      return {
        ...base,
        position: 'center',
        fontSize: 48,
        color: '#d9f2ff',
        outline: true,
        outlineColor: '#2a4f6b',
        outlineWidth: 5,
        animation: 'fadeIn'
      }
    case 'situation':
    case 'place':
      return {
        ...base,
        position: 'top',
        fontSize: 44,
        color: '#ffffff',
        outline: true,
        outlineColor: '#333333',
        outlineWidth: 4,
        background: true,
        backgroundColor: '#000000',
        backgroundOpacity: 0.55
      }
    case 'corner':
      return {
        ...base,
        position: 'top',
        fontSize: 56,
        color: '#ffffff',
        outline: true,
        outlineColor: '#c8156a',
        outlineWidth: 6,
        bold: true,
        animation: 'slideInDown'
      }
  }
}

/** 演出テロップを出す長さ(秒) */
export const EFFECT_DURATION_SEC = 2.2

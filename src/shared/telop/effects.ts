import type { TextStyle } from '../types'
import { defaultTextStyle } from '../textStyle'

/**
 * 演出テロップ(計画書 §5.8): ツッコミ・心の声・状況説明・地名・コーナー名・強調・擬音・注釈・人物紹介。
 * 人物紹介(名前スーパー)だけは AI を使わず、各出演者の最初の発言に自動で付ける(`nameProposals`)。
 *
 * AI(Gemini)が、発言の流れを読んで「どの発言の後に・どの種類で・何と出すか・自信度」を提案する。
 * 自信の高いもの(`AUTO_PLACE_CONFIDENCE` 以上)だけを自動で置き、残りは提案として人が選ぶ。
 * 送るのは話者つきの文字起こしだけ。発言そのものを書き換える提案は受け付けない(演出の文だけ)。
 */

export type EffectKind =
  | 'tsukkomi'
  | 'kokoro'
  | 'situation'
  | 'place'
  | 'corner'
  | 'emphasis'
  | 'sfx'
  | 'note'
  | 'name'
  | 'laugh'
  | 'clock'
  | 'chapter'
  | 'bubble'
  | 'translate'
  | 'dialect'
  | 'teaser'
  | 'price'
  | 'route'
  | 'narration'
  | 'quiz'
  | 'counter'
  | 'hand'

export const EFFECT_LABEL: Record<EffectKind, string> = {
  tsukkomi: 'ツッコミ',
  kokoro: '心の声',
  situation: '状況説明',
  place: '地名・情報',
  corner: 'コーナー名',
  emphasis: '強調',
  sfx: '擬音',
  note: '注釈',
  name: '人物紹介',
  laugh: '笑いの添え字',
  clock: '時刻・天気',
  chapter: '章タイトル',
  bubble: '吹き出し',
  translate: '翻訳字幕',
  dialect: '方言の補足',
  teaser: '引き(このあと…)',
  price: '店名・価格',
  route: '移動ルート',
  narration: 'ナレーション',
  quiz: 'クイズ・お題',
  counter: 'カウンター',
  hand: '手書き'
}

/**
 * AI に提案させる種類。人物紹介・笑い・時刻・章・吹き出しは AI を使わずに決まり、
 * ナレーション・クイズ・カウンター・手書きは人が置く
 */
export const AI_EFFECT_KINDS: EffectKind[] = [
  'tsukkomi',
  'kokoro',
  'situation',
  'place',
  'corner',
  'emphasis',
  'sfx',
  'note',
  'translate',
  'dialect',
  'teaser',
  'price',
  'route'
]

/**
 * 発言に重ねて出す種類(発言の頭から)。ほかの種類は発言の終わりから出す(ツッコミは言い終わってから)
 */
export const EFFECT_AT_LINE_START: ReadonlySet<EffectKind> = new Set(['name', 'emphasis'])

/** 種類ごとの出す長さ(秒)。人物紹介は読む時間を長めに */
export function effectDuration(kind: EffectKind): number {
  return kind === 'name' ? 3.5 : EFFECT_DURATION_SEC
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

/** 頼み文の中の例。AI がそのまま写した答えは捨てる(小さいモデルで起きる) */
const EXAMPLES = {
  tsukkomi: 'いや早すぎ!',
  kokoro: '(帰りたい…)',
  situation: 'ここまで歩いて40分',
  place: '浄土ヶ浜',
  sfx: 'ドーン!',
  note: '※撮影時の価格です'
} as const

/** 比べるための形(全角・半角、空白・記号の違いをならす) */
function textKey(text: string): string {
  return text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '')
}

const EXAMPLE_KEYS = new Set(Object.values(EXAMPLES).map(textKey))

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
- tsukkomi: ツッコミ(発言へのひとこと。例「${EXAMPLES.tsukkomi}」)
- kokoro: 心の声(話者の内心。例「${EXAMPLES.kokoro}」)
- situation: 状況説明(例「${EXAMPLES.situation}」)
- place: 地名・情報(発言に出てきた地名や店名。例「${EXAMPLES.place}」)
- corner: コーナー名(企画の区切り)
- emphasis: 強調(発言の中の印象的な言葉を大きく出す。**発言の中の言葉をそのまま**抜き出す)
- sfx: 擬音(場面の空気を表す音の文字。例「${EXAMPLES.sfx}」「シーン…」)
- note: 注釈(誤解されそうな所の補足。「※」で始める。例「${EXAMPLES.note}」)
決まり:
- 1つの文は${MAX_TEXT_CHARS}字以内。発言を書き換えたり、言っていない事実を作ったりしない
- 例の文をそのまま使わない。同じ文を何度も使わない
- 地名・状況説明・注釈は、発言の中に根拠があるものだけ
- 強調は発言の中の言葉だけ(言い換えない)
- 多すぎると邪魔なので、本当に効くものだけ(目安: 1分に1つまで)
- confidence: 0〜1(番組でそのまま使えると思う確からしさ)

発言:
${list}

次の JSON だけを返してください:
{"effects":[{"after":"発言のID","kind":"tsukkomi","text":"","confidence":0.0,"reason":"理由(日本語1文)"}]}`
}

const KINDS = AI_EFFECT_KINDS

export function parseEffectAnswer(answer: unknown, lines: readonly EffectLine[]): EffectProposal[] {
  const ids = new Set(lines.map((l) => l.id))
  const lineText = new Map(lines.map((l) => [l.id, l.text]))
  const list =
    answer && typeof answer === 'object' && Array.isArray((answer as { effects?: unknown }).effects)
      ? ((answer as { effects: unknown[] }).effects as unknown[])
      : []
  const out: EffectProposal[] = []
  const seen = new Set<string>()
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
    // 例の写し・同じ文の繰り返しは捨てる(使える提案ではない)。
    // ただし例と同じ言葉が、その発言の中に本当にある(地名など)なら残す
    const key = textKey(text)
    const lineKey = textKey(lineText.get(after) ?? '')
    const copied = EXAMPLE_KEYS.has(key) && !lineKey.includes(key)
    if (!key || copied || seen.has(key)) continue
    // 強調は発言の中の言葉そのままに限る(言っていない言葉を大きく出さない)
    if (kind === 'emphasis' && !lineKey.includes(key)) continue
    seen.add(key)
    // 注釈は「※」で始める(番組の注釈の書き方)
    const shown = kind === 'note' && !/^[※*]/.test(text) ? `※${text}` : text
    out.push({
      id: `fx-${after}-${out.length}`,
      afterLineId: after,
      kind,
      text: shown,
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
    case 'emphasis':
      // 発言の言葉を画面の真ん中に大きく
      return {
        ...base,
        position: 'center',
        fontSize: 76,
        color: '#ffffff',
        outline: true,
        outlineColor: '#d0021b',
        outlineWidth: 7,
        bold: true,
        animation: 'popIn',
        extraStrokes: [{ color: '#ffffff', width: 5 }]
      }
    case 'sfx':
      // 右上寄りに、少し傾けて弾ませる
      return {
        ...base,
        position: 'center',
        customPosition: { x: 0.74, y: 0.3 },
        fontSize: 84,
        color: '#ffd400',
        outline: true,
        outlineColor: '#111111',
        outlineWidth: 7,
        bold: true,
        rotation: -8,
        animation: 'bounce'
      }
    case 'note':
      // 右下に小さく(発言テロップの邪魔をしない)
      return {
        ...base,
        position: 'bottom',
        customPosition: { x: 0.8, y: 0.93 },
        fontSize: 26,
        color: '#ffffff',
        outline: true,
        outlineColor: '#000000',
        outlineWidth: 3,
        bold: false,
        animation: 'fadeIn'
      }
    case 'name':
      // 左下の名前スーパー。白い帯に濃い文字(どんな画の上でも読める)。発言テロップ(下中央)と重ならない高さ
      return {
        ...base,
        position: 'bottom',
        customPosition: { x: 0.2, y: 0.7 },
        fontSize: 44,
        color: '#1a1a1a',
        outline: false,
        bold: true,
        background: true,
        backgroundColor: '#ffffff',
        backgroundOpacity: 0.92,
        animation: 'slideInUp'
      }
    case 'laugh':
      // 左上に、少し傾けた添え字
      return {
        ...base,
        position: 'top',
        customPosition: { x: 0.15, y: 0.14 },
        fontFamily: 'RocknRoll One',
        fontSize: 40,
        color: '#ffffff',
        outline: true,
        outlineColor: '#e8457a',
        outlineWidth: 5,
        rotation: -4,
        animation: 'popIn'
      }
    case 'clock':
      // 左上の黒い札(撮影時刻。天気・気温は人が足す)
      return {
        ...base,
        position: 'top',
        customPosition: { x: 0.13, y: 0.09 },
        fontFamily: 'Noto Sans JP',
        fontSize: 34,
        color: '#ffffff',
        outline: false,
        background: true,
        backgroundShape: 'block',
        backgroundColor: '#000000',
        backgroundOpacity: 0.6,
        backgroundRadius: 8,
        backgroundPadding: { x: 18, y: 6 },
        sub: { scale: 0.8, color: '#ffe14d' },
        animation: 'fadeIn'
      }
    case 'chapter':
      // 真ん中に大きく。1行目(第○章)は小さく金色。漢字が多いので極太の書体でも中がつぶれない Noto の 900
      return {
        ...base,
        position: 'center',
        fontFamily: 'Noto Sans JP',
        fontWeight: 900,
        fontSize: 92,
        color: '#ffffff',
        fillGradient: {
          angle: 0,
          stops: [
            { at: 0, color: '#ffffff' },
            { at: 1, color: '#ffe3a1' }
          ]
        },
        outline: true,
        outlineColor: '#1b2a4a',
        outlineWidth: 6,
        extraStrokes: [{ color: '#ffffff', width: 4 }],
        shadow: true,
        shadowBlur: 14,
        shadowDistance: 8,
        shadowOpacity: 0.55,
        firstLine: { scale: 0.45, color: '#ffd54a' },
        animation: 'popIn'
      }
    case 'bubble':
      // 白い吹き出し(しっぽは話している人の方へ)
      return {
        ...base,
        position: 'center',
        customPosition: { x: 0.3, y: 0.32 },
        fontFamily: 'M PLUS Rounded 1c',
        fontWeight: 800,
        fontSize: 46,
        color: '#222222',
        outline: false,
        background: true,
        backgroundShape: 'bubble',
        backgroundColor: '#ffffff',
        backgroundOpacity: 1,
        backgroundRadius: 40,
        backgroundPadding: { x: 30, y: 16 },
        backgroundBorder: { color: '#222222', width: 4 },
        bubbleTail: { side: 'bottom', at: 0.25, length: 34 },
        animation: 'popIn'
      }
    case 'translate':
      // 外国語の発言テロップの上に、日本語訳を黄色で
      return {
        ...base,
        position: 'bottom',
        customPosition: { x: 0.5, y: 0.76 },
        fontSize: 46,
        color: '#ffe14d',
        outline: true,
        outlineColor: '#000000',
        outlineWidth: 5,
        bold: true,
        animation: 'fadeIn'
      }
    case 'dialect':
      // 発言テロップの上に、小さく意味を添える
      return {
        ...base,
        position: 'bottom',
        customPosition: { x: 0.5, y: 0.77 },
        fontSize: 30,
        color: '#ffffff',
        outline: false,
        bold: false,
        background: true,
        backgroundColor: '#000000',
        backgroundOpacity: 0.55,
        backgroundRadius: 6,
        animation: 'fadeIn'
      }
    case 'teaser':
      // 斜めの赤い板に、このあと…(1行目を小さく)
      return {
        ...base,
        position: 'center',
        fontFamily: 'Noto Sans JP',
        fontWeight: 900,
        fontSize: 70,
        color: '#ffe14d',
        fillGradient: {
          angle: 0,
          stops: [
            { at: 0, color: '#fff6b0' },
            { at: 1, color: '#ffb300' }
          ]
        },
        outline: true,
        outlineColor: '#5a0010',
        outlineWidth: 4,
        background: true,
        backgroundShape: 'block',
        backgroundColor: '#c8102e',
        backgroundGradient: {
          angle: 90,
          stops: [
            { at: 0, color: '#e2183a' },
            { at: 1, color: '#7a0019' }
          ]
        },
        backgroundOpacity: 0.92,
        backgroundSkew: -10,
        backgroundPadding: { x: 48, y: 14 },
        firstLine: { scale: 0.5, color: '#ffffff' },
        animation: 'slideInUp'
      }
    case 'price':
      // 右上の札: 店名(1行目)・品名・**値段**
      return {
        ...base,
        position: 'top',
        customPosition: { x: 0.8, y: 0.2 },
        fontFamily: 'Noto Sans JP',
        fontSize: 40,
        color: '#ffffff',
        outline: false,
        bold: true,
        align: 'left',
        background: true,
        backgroundShape: 'block',
        backgroundColor: '#14213d',
        backgroundOpacity: 0.92,
        backgroundRadius: 10,
        backgroundBorder: { color: '#ffd54a', width: 3 },
        backgroundPadding: { x: 26, y: 14 },
        firstLine: { scale: 0.7, color: '#ffd54a' },
        accent: { scale: 1.3, color: '#ffd54a' },
        animation: 'slideInDown'
      }
    case 'route':
      // 左上の緑の帯: 出発 __→ 手段と時間 →__ 到着
      return {
        ...base,
        position: 'top',
        customPosition: { x: 0.24, y: 0.1 },
        fontFamily: 'Noto Sans JP',
        fontSize: 38,
        color: '#ffffff',
        outline: false,
        bold: true,
        background: true,
        backgroundShape: 'block',
        backgroundColor: '#0b6e4f',
        backgroundOpacity: 0.92,
        backgroundRadius: 30,
        backgroundPadding: { x: 28, y: 8 },
        sub: { scale: 0.7, color: '#c8f7dc' },
        animation: 'slideInDown'
      }
    case 'narration':
      // 明朝で、縁を付けずにやわらかい影
      return {
        ...base,
        position: 'bottom',
        fontFamily: 'Shippori Mincho',
        fontSize: 42,
        color: '#ffffff',
        outline: false,
        bold: false,
        letterSpacing: 2,
        shadow: true,
        shadowBlur: 6,
        shadowDistance: 2,
        shadowOpacity: 0.85,
        animation: 'fadeIn'
      }
    case 'quiz':
      // 上に青い札。「**Q.**」を黄色に
      return {
        ...base,
        position: 'top',
        fontFamily: 'Noto Sans JP',
        fontSize: 48,
        color: '#ffffff',
        outline: false,
        bold: true,
        background: true,
        backgroundShape: 'block',
        backgroundColor: '#1565c0',
        backgroundGradient: {
          angle: 0,
          stops: [
            { at: 0, color: '#1e88e5' },
            { at: 1, color: '#0d47a1' }
          ]
        },
        backgroundOpacity: 0.95,
        backgroundRadius: 12,
        backgroundBorder: { color: '#ffffff', width: 3 },
        backgroundPadding: { x: 32, y: 14 },
        accent: { scale: 1.2, color: '#ffd54a' },
        animation: 'slideInDown'
      }
    case 'counter':
      // 右上に出し続ける数字(**数字**を大きく黄色に)
      return {
        ...base,
        position: 'top',
        customPosition: { x: 0.85, y: 0.12 },
        fontFamily: 'Noto Sans JP',
        fontSize: 36,
        color: '#ffffff',
        outline: true,
        outlineColor: '#000000',
        outlineWidth: 4,
        bold: true,
        accent: { scale: 1.8, color: '#ffe14d' },
        animation: 'popIn'
      }
    case 'hand':
      // 手書きの文字と矢印で「ここ!」
      return {
        ...base,
        position: 'center',
        customPosition: { x: 0.62, y: 0.4 },
        fontFamily: 'Yomogi',
        fontSize: 56,
        color: '#ff3b30',
        outline: true,
        outlineColor: '#ffffff',
        outlineWidth: 5,
        bold: true,
        rotation: -6,
        pointer: { dx: -0.12, dy: 0.12, color: '#ff3b30', width: 6, hand: true },
        animation: 'popIn'
      }
  }
}

/** 演出テロップを出す長さ(秒) */
export const EFFECT_DURATION_SEC = 2.2

/** このPCの AI に渡す、演出テロップの出力の形。「どの発言の後か」は実在する発言の ID からしか選べない */
export function effectSchema(lines: readonly EffectLine[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      effects: {
        type: 'array',
        // 個数・文字数の上限は、小さいモデルが同じ答えを繰り返して尽きるのを防ぐ
        maxItems: Math.max(1, Math.min(60, lines.length)),
        items: {
          type: 'object',
          properties: {
            after: { enum: lines.map((l) => l.id) },
            kind: { enum: AI_EFFECT_KINDS },
            reason: { type: 'string', maxLength: 120 },
            text: { type: 'string', maxLength: MAX_TEXT_CHARS + 4 },
            confidence: { type: 'number' }
          },
          required: ['after', 'kind', 'reason', 'text', 'confidence']
        }
      }
    },
    required: ['effects']
  }
}

/** 既定の名前(マイク1・カメラA・話者2 など)。人物紹介には出さない */
const DEFAULT_NAME = /^(マイク|カメラ|話者|PIN|MIC|CAM)\s*[0-9０-９A-ZＡ-Ｚa-z]*$/i

/**
 * 人物紹介(名前スーパー)の提案。各出演者の最初の発言に、名前を出す(AI を使わない)。
 * 名前を付けていない話者(既定の名前)には出さない。
 */
export function nameProposals(lines: readonly EffectLine[]): EffectProposal[] {
  const seen = new Set<string>()
  const out: EffectProposal[] = []
  for (const l of [...lines].sort((a, b) => a.start - b.start)) {
    const name = l.speaker?.trim()
    if (!name || name === '?' || DEFAULT_NAME.test(name) || seen.has(name)) continue
    seen.add(name)
    out.push({
      id: `name-${name}`,
      afterLineId: l.id,
      kind: 'name',
      text: name,
      confidence: 1,
      reason: '最初の登場'
    })
  }
  return out
}

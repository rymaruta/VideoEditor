import type { Scene, SceneJudgement, SceneKind } from './scenes'

/**
 * 構成を AI(Gemini)に判定させるための、頼む文面と答えの検証(計画書 §5.5)。
 * 送るのは**文字起こし(話者つき)だけ**(計画書 §10: 素材の映像・音声そのものは送らない)。
 * 数時間ぶんは1回に入らないので、場面をまとめて区切って頼む(`chunkScenes`)。
 */

export interface StructureRequestOptions {
  episodeName: string
  /** 仕上がりの長さ(秒) */
  targetSec: number
  /** 編集方針などの自由記入 */
  note?: string
}

/** 1回に送る場面の数と文字数の上限 */
const MAX_SCENES_PER_REQUEST = 40
const MAX_CHARS_PER_REQUEST = 24000
const MAX_CHARS_PER_SCENE = 900

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function sceneText(s: Scene): string {
  if (s.lines.length === 0) return '(会話なし)'
  const body = s.lines.map((l) => `${l.speaker ?? '?'}「${l.text}」`).join(' ')
  return body.length > MAX_CHARS_PER_SCENE ? body.slice(0, MAX_CHARS_PER_SCENE) + '…' : body
}

export function chunkScenes(scenes: readonly Scene[]): Scene[][] {
  const chunks: Scene[][] = []
  let cur: Scene[] = []
  let chars = 0
  for (const s of scenes) {
    const len = sceneText(s).length + 40
    if (
      cur.length > 0 &&
      (cur.length >= MAX_SCENES_PER_REQUEST || chars + len > MAX_CHARS_PER_REQUEST)
    ) {
      chunks.push(cur)
      cur = []
      chars = 0
    }
    cur.push(s)
    chars += len
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

export function buildStructurePrompt(
  scenes: readonly Scene[],
  totalSec: number,
  options: StructureRequestOptions
): string {
  const list = scenes
    .map((s) => `[${s.id}] ${clock(s.start)}〜${clock(s.end)} ${sceneText(s)}`)
    .join('\n')
  return `あなたはテレビのバラエティ番組(ロケ番組)の編集者です。
番組「${options.episodeName}」の収録素材(全体 ${clock(totalSec)})を、仕上がり ${clock(options.targetSec)} に編集します。
以下は収録の一部を、話のまとまり(場面)ごとに並べた文字起こしです(「話者「発言」」の形)。
${options.note ? `編集方針: ${options.note}\n` : ''}
各場面について、番組として残す価値を判定してください。
- score: 0〜100。笑い・驚き・掛け合いの盛り上がり・企画の要点・感情の動きがある場面ほど高く
- kind: "highlight"(見どころ) / "normal"(つなぎとして使える) / "unneeded"(不要: 移動だけ・待機・段取りの相談・言い直しなど)
- title: 場面の短い見出し(日本語15字以内)
- reason: そう判定した理由(日本語1文。発言を引用してよい)
発言の内容を作り変えたり、無い発言を書いたりしないでください。

場面:
${list}

次の JSON だけを返してください:
{"scenes":[{"id":"場面のID","score":0,"kind":"normal","title":"","reason":""}]}`
}

const KINDS: SceneKind[] = ['highlight', 'normal', 'unneeded']

/**
 * AI の答えを検証する。頼んでいない ID・範囲外の点数・知らない種類は捨てる。
 * 答えの無かった場面は返さない(呼び出し側で簡易の点数で埋める)。
 */
export function parseStructureAnswer(answer: unknown, scenes: readonly Scene[]): SceneJudgement[] {
  const ids = new Set(scenes.map((s) => s.id))
  const list =
    answer && typeof answer === 'object' && Array.isArray((answer as { scenes?: unknown }).scenes)
      ? ((answer as { scenes: unknown[] }).scenes as unknown[])
      : []
  const out = new Map<string, SceneJudgement>()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id : undefined
    const score = typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : NaN
    const kind = KINDS.find((k) => k === o.kind)
    if (!id || !ids.has(id) || Number.isNaN(score) || !kind || out.has(id)) continue
    out.set(id, {
      sceneId: id,
      score: Math.max(0, Math.min(100, Math.round(score))),
      kind,
      title: typeof o.title === 'string' ? o.title.slice(0, 30) : undefined,
      reason:
        typeof o.reason === 'string' && o.reason.trim()
          ? o.reason.trim().slice(0, 200)
          : 'AI の判定'
    })
  }
  return [...out.values()]
}

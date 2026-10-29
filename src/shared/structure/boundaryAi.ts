import type { LlmRequest } from '../llm'
import {
  continuesSentence,
  HOLD_MAX_RATIO,
  speechSeconds,
  type Scene,
  type SceneOptions,
  type TimedLine
} from './scenes'

/**
 * 場面の区切りの AI による直し(足し算の後段)。
 *
 * 場面の区切り(`buildScenes`)は公開中の版(0f27f36)のまま。そのうち「怪しい」区切り(前の場面が言いかけで
 * 終わる)だけを AI に見せて、直すのは「確実に悪い」区切りだけ:
 *
 * 0. まず答えの決まった切れ目(`controlGaps`: 作った例文の「話の切れ目」「話の途中」)を聞く。
 *    中身によらず同じ言葉を選ぶ AI(CPU の 1.5B は全部「話の途中」、3B は先に書いた言葉)はここで外れるので、
 *    その回は何も直さない(怪しい区切りの分は頼まない)
 * 1. 今の区切りの前後が「話の途中」(同じ文の続き・質問とその答えの間・言いかけの続き)か「話の切れ目」かを
 *    聞く。2通りの頼み方(選ぶ言葉の並びが逆)の両方が「話の途中」と答えたときだけ、直す区切りとする
 *    (小さいモデルは中身によらず先に書いた言葉に寄るので、2つの答えが合うのは中身を見て答えたときだけ)
 * 2. 直す区切りの片側が短い場面(`minTailSec` 未満)なら、その場面を丸ごと反対側へ入れる(試し編集 第4回 N4:
 *    文の途中から始まる 9 秒の場面が仕上がりの最後に残り、言いかけで終わった)。新しい切れ目は増えない
 *    (短い場面の向こうの端は、もともと区切り)。場面を落とす判断はしない
 * 3. そうでなければ、近くの発話の間(前後 `MAX_SHIFT_LINES` 発話・`MAX_SHIFT_SEC` 秒まで。言いかけで終わる
 *    発話の後は除く)のそれぞれを同じく2通りで聞き、両方が「話の切れ目」と答えた所のうち今の区切りに
 *    いちばん近い所へ動かす
 *
 * AI が使えない・答えが壊れている・2つの答えが食い違うときは何もしない(今の区切りのまま)。
 * 動かすのは発話の境で前後の発話に間(`MIN_GAP_SEC` 以上)がある所だけ。場面の長さは上限(長さの目安の
 * `HOLD_MAX_RATIO` 倍)を超えない・下限(`minTailSec`)を割らない(もともと外れていた場面は、それ以上悪く
 * しない)。1つの場面に2つの直しは掛けない。
 *
 * 決めた直し(`SceneMove`)は企画に保存し、開き直しでは同じ直しを当てる(`applySceneMoves`。AI に聞き直さない)
 */

export interface SceneMove {
  /** 動かす前の区切りの時刻(共通の時間軸の秒) */
  at: number
  /**
   * 動かした先の時刻。隣の場面の反対の端と同じなら、その(短い)場面を丸ごと隣へ入れた(場面が1つ減る)
   */
  to: number
}

/** 区切りを動かせる幅(発話の数・秒) */
export const MAX_SHIFT_LINES = 3
export const MAX_SHIFT_SEC = 30
/** 区切りを入れてよい発話の間の下限(秒)。これより詰まった所は話が続いている */
export const MIN_GAP_SEC = 0.2
/** AI に見せる、切れ目の前後の発話の数 */
const VIEW_LINES = 2
/** 1つの発話を見せる字数の上限(前の発話は終わり、後ろの発話は頭を残す) */
const MAX_LINE_CHARS = 80

export interface BoundaryCandidate {
  /** 切れ目の後ろの発話の位置(`BoundaryQuestion.all` の中) */
  cut: number
  /** 区切りの時刻 */
  time: number
  /** 今の区切り */
  current: boolean
  /** 短い場面を丸ごと隣へ入れる(新しい切れ目は増えない) */
  merge?: 'forward' | 'backward'
}

export interface BoundaryQuestion {
  /** 今の区切りの時刻 */
  at: number
  /** 区切りの前の場面の位置(`scenes` の中。後ろの場面は index + 1) */
  index: number
  /** 前後に見せる発話を含む、時刻順の発話(場面をまたぐ) */
  all: TimedLine[]
  /** 今の区切りの後ろの発話の位置(`all` の中) */
  cut: number
  /** 動かせる先(今の区切りを含む。時刻順) */
  candidates: BoundaryCandidate[]
  /** なぜ怪しいか */
  why: ('open' | 'short')[]
}

interface Limits {
  quiet: number
  minTail: number
  maxLen: number
}

function limitsOf(options: SceneOptions): Limits {
  return {
    quiet: options.quietSec ?? 8,
    minTail: options.minTailSec ?? 20,
    maxLen: (options.maxSceneSec ?? 90) * HOLD_MAX_RATIO
  }
}

/** 言い切り・問いかけの形の文末(ここで終わる発話は、話の切れ目になりうる) */
const CLOSED_TAIL =
  /(?:[。．.!?！？」』）)]|ます|ました|ません|ましょう|です|でした|でしょう|ですね|ですよ|だ|だった|だね|だよ|た|ない|ね|よ|な|わ|か|ください|下さい)$/u

/**
 * 発話が言いかけで終わっているか(言い切り・問いかけの形でない。「…我々は」「…という形で」
 * 「…日立健貴さんは」)。音声認識は句読点を付けないことが多いので、文末の形で見る。聞く区切りを絞るだけ
 * (動かすかどうかは AI が決める)
 */
export function endsOpen(text: string): boolean {
  const t = text.replace(/[\s\u3000、,，]+$/u, '')
  if (!t) return false
  if (continuesSentence(t)) return true
  return !CLOSED_TAIL.test(t)
}

/** 場面の長さが、動かした後も上限・下限を守るか(もともと外れていた場面は、それ以上悪くしない) */
function lengthOk(before: number, after: number, lim: Limits, mayVanish: boolean): boolean {
  if (after <= 1e-6) return mayVanish
  if (after > lim.maxLen + 1e-6 && after > before + 1e-6) return false
  if (after < lim.minTail - 1e-6 && after < before - 1e-6) return false
  return true
}

/** 区切り(前の場面 a・後ろの場面 c の間)を動かせる先(今の区切りを含む。時刻順。cut は a・c の発話の中の位置) */
export function boundaryCandidates(a: Scene, c: Scene, options: SceneOptions): BoundaryCandidate[] {
  const lim = limitsOf(options)
  const lines = [...a.lines, ...c.lines]
  const k = a.lines.length
  const at = a.end
  const out: BoundaryCandidate[] = []
  const aShort = a.end - a.start < lim.minTail
  const cShort = c.end - c.start < lim.minTail
  const from = Math.max(0, k - MAX_SHIFT_LINES)
  const to = Math.min(lines.length, k + MAX_SHIFT_LINES)
  for (let cut = from; cut <= to; cut++) {
    if (cut === k) {
      out.push({ cut, time: at, current: true })
      continue
    }
    let time: number
    let merge: BoundaryCandidate['merge']
    if (cut === 0) {
      // 前の(短い)場面を丸ごと後ろの場面へ
      if (!aShort) continue
      time = a.start
      merge = 'backward'
    } else if (cut === lines.length) {
      // 後ろの(短い)場面を丸ごと前の場面へ
      if (!cShort) continue
      time = c.end
      merge = 'forward'
    } else {
      // 言いかけで終わる発話の後へは動かさない(新しい区切りが話の途中になる。試し編集 第4回で 7B が
      // 「…アドバイスをいただきながら」の後を切れ目と答えた)
      if (endsOpen(lines[cut - 1].text)) continue
      const prevEnd = Math.max(...lines.slice(0, cut).map((l) => l.end))
      const nextStart = lines[cut].start
      const gap = nextStart - prevEnd
      if (gap < MIN_GAP_SEC) continue
      time = gap >= lim.quiet ? prevEnd + 0.5 : (prevEnd + nextStart) / 2
      if (!(time > a.start + 1e-6 && time < c.end - 1e-6)) continue
      if (Math.abs(time - at) > MAX_SHIFT_SEC) continue
    }
    // 動く発話の長さ
    const moved = cut < k ? lines.slice(cut, k) : lines.slice(k, cut)
    const span = Math.max(...moved.map((l) => l.end)) - Math.min(...moved.map((l) => l.start))
    if (span > MAX_SHIFT_SEC) continue
    if (
      !lengthOk(a.end - a.start, time - a.start, lim, aShort) ||
      !lengthOk(c.end - c.start, c.end - time, lim, cShort)
    )
      continue
    out.push({ cut, time, current: false, ...(merge ? { merge } : {}) })
  }
  return out
}

/**
 * AI に聞く区切り(怪しいものだけ)。前後どちらも話している場面で、前の場面が言いかけで終わる(`endsOpen`)
 * もの(`why` の short は、どちらかが短い場面(`minTailSec` 未満)で丸ごと入れられること)。動かせる先が無ければ
 * 聞かない
 */
export function suspectBoundaries(
  scenes: readonly Scene[],
  options: SceneOptions = {}
): BoundaryQuestion[] {
  const lim = limitsOf(options)
  const out: BoundaryQuestion[] = []
  for (let i = 0; i + 1 < scenes.length; i++) {
    const a = scenes[i]
    const c = scenes[i + 1]
    if (a.lines.length === 0 || c.lines.length === 0) continue
    if (Math.abs(a.end - c.start) > 1e-6) continue
    const why: BoundaryQuestion['why'] = []
    if (endsOpen(a.lines[a.lines.length - 1].text)) why.push('open')
    if (a.end - a.start < lim.minTail || c.end - c.start < lim.minTail) why.push('short')
    // 言い切りで終わる区切りは聞かない(短い場面の端でも。試し編集 第4回で 7B が「…すごく考えました」の後を
    // 話の途中と答え、8 秒の場面を続きの無い後ろの場面へ入れていた)
    if (!why.includes('open')) continue
    const candidates = boundaryCandidates(a, c, options)
    if (!candidates.some((x) => !x.current)) continue
    // 前後の場面の発話(切れ目の前後に見せる分も)
    const prev = scenes
      .slice(0, i)
      .flatMap((s) => s.lines)
      .slice(-VIEW_LINES)
    const next = scenes
      .slice(i + 2)
      .flatMap((s) => s.lines)
      .slice(0, VIEW_LINES)
    out.push({
      at: a.end,
      index: i,
      all: [...prev, ...a.lines, ...c.lines, ...next],
      cut: prev.length + a.lines.length,
      candidates: candidates.map((x) => ({ ...x, cut: x.cut + prev.length })),
      why
    })
  }
  return out
}

/** 頼み方(2通り。はい/いいえの向きが逆) */
export type GapVariant = 0 | 1
/** 切れ目の前後の話の答え */
export type GapVerdict = 'continues' | 'breaks'

function tailOf(text: string): string {
  const c = [...text.trim()]
  return c.length <= MAX_LINE_CHARS ? c.join('') : '…' + c.slice(-MAX_LINE_CHARS).join('')
}
function headOf(text: string): string {
  const c = [...text.trim()]
  return c.length <= MAX_LINE_CHARS ? c.join('') : c.slice(0, MAX_LINE_CHARS).join('') + '…'
}

/** 答えの言葉 */
const CONTINUES = '話の途中'
const BREAKS = '話の切れ目'

/**
 * 1つの切れ目(`all` の `cut` 番目の発話の前)について、話が続いているかを聞く文。2通りの頼み方は、選ぶ言葉の
 * 並びが逆(variant 0 は「話の途中」が先、1 は「話の切れ目」が先)。小さいモデルは中身によらず先の言葉や
 * 「いいえ」に寄るので、2つの答えが合うのは中身を見て答えたときだけ
 */
export function buildGapPrompt(
  all: readonly TimedLine[],
  cut: number,
  variant: GapVariant
): string {
  const before = all.slice(Math.max(0, cut - VIEW_LINES), cut)
  const after = all.slice(cut, cut + VIEW_LINES)
  const say = (l: TimedLine, text: string): string =>
    `${l.speaker ? `${l.speaker}` : ''}「${text}」`
  const rows = [
    ...before.map((l) => say(l, tailOf(l.text))),
    '──── ここ ────',
    ...after.map((l) => say(l, headOf(l.text)))
  ]
  const [x, y] = variant === 0 ? [CONTINUES, BREAKS] : [BREAKS, CONTINUES]
  const desc: Record<string, string> = {
    [CONTINUES]: `「${CONTINUES}」: 「ここ」が文の途中・質問とその答えの間・言いかけの途中にある(前の発話の続きが後ろにある)`,
    [BREAKS]: `「${BREAKS}」: 「ここ」の前で文や話が終わり、後ろから新しい文・新しい話・新しい質問が始まる`
  }
  return `テレビ番組の収録の文字起こしです。音声認識は声の間で発話を分けるので、1つの文が2つの発話に分かれることがあります。
発話(時刻順):
${rows.join('\n')}
「ここ」は話の途中ですか、話の切れ目ですか。
${desc[x]}
${desc[y]}
reason に理由(日本語1文)を先に書き、answer に「${x}」か「${y}」のどちらかを入れた JSON だけを返してください。`
}

export function gapSchema(variant: GapVariant): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      // 理由を先に書かせる(先に根拠を書かせると、言葉の並びに寄った答えが減った: 7B で確かめ)。
      // 字数の上限は、小さいモデルが同じ言葉を繰り返して尽きるのを防ぐ
      reason: { type: 'string', maxLength: 60 },
      answer: { enum: variant === 0 ? [CONTINUES, BREAKS] : [BREAKS, CONTINUES] }
    },
    required: ['reason', 'answer']
  }
}

/** 答えを「続いている / 一区切り」に直す。壊れた答えは null */
export function parseGapAnswer(answer: unknown): GapVerdict | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null
  const a = (answer as Record<string, unknown>).answer
  return a === CONTINUES ? 'continues' : a === BREAKS ? 'breaks' : null
}

/** 2通りの答えがそろったときだけの答え(食い違い・壊れた答えは null) */
export function agreedVerdict(a0: unknown, a1: unknown): GapVerdict | null {
  const v0 = parseGapAnswer(a0)
  const v1 = parseGapAnswer(a1)
  return v0 !== null && v0 === v1 ? v0 : null
}

function gapRequests(all: readonly TimedLine[], cut: number): LlmRequest[] {
  return ([0, 1] as const).map((v) => ({
    prompt: buildGapPrompt(all, cut, v),
    schema: gapSchema(v),
    maxTokens: 120
  }))
}

export interface ControlGap {
  all: TimedLine[]
  cut: number
  expect: GapVerdict
}

/**
 * AI の答えを確かめる、答えの決まった切れ目(作った例文。前・後ろの発話と、正しい答え)。
 * 初めは収録の文字起こしから「言い切りの後の無言」を選んでいたが、話が続いている所(「…戻ってまいりました」
 * 「それまでは…」)が混じり、7B も「話の途中」と答えた。作った例文なら答えが揺れない
 */
const CONTROL_EXAMPLES: { before: string[]; after: string[]; expect: GapVerdict }[] = [
  {
    before: ['今日は皆さん本当にありがとうございました', '以上で今日のロケは終わりです'],
    after: ['それでは次のコーナーに移ります', '続いては料理の時間です'],
    expect: 'breaks'
  },
  {
    before: ['うちの店は創業50年になります', '今は息子と2人でやっています'],
    after: ['では次の方にお聞きします', '好きな食べ物は何ですか'],
    expect: 'breaks'
  },
  {
    before: ['実は私たちは毎朝', 'この坂道を'],
    after: ['駅まで歩いて通っているんですけども', '冬はとても寒いです'],
    expect: 'continues'
  },
  {
    before: ['このお店のラーメンは', 'スープが'],
    after: ['とても濃厚で', '本当においしいんです'],
    expect: 'continues'
  }
]

/**
 * AI の答えを確かめる切れ目(`CONTROL_EXAMPLES`。怪しい区切りより先に聞く)。話者の名前は収録の最初の話者に
 * そろえる。小さいモデルは中身によらず全部に「話の途中」と答えたり(CPU の 1.5B)、先に書いた言葉を選んだり
 * (3B)する。確かめを1つでもそろって逆に答えた・1つもそろって正しく答えなかったら、その回の答えは使わない
 */
export function controlGaps(scenes: readonly Scene[]): ControlGap[] {
  const speaker = scenes.flatMap((s) => s.lines).find((l) => l.speaker)?.speaker
  return CONTROL_EXAMPLES.map((x, n) => {
    const lines = [...x.before, ...x.after].map((text, i): TimedLine => ({
      id: `control${n}-${i}`,
      ...(speaker ? { speaker } : {}),
      start: i * 3,
      end: i * 3 + 2.5,
      text,
      overlap: false
    }))
    return { all: lines, cut: x.before.length, expect: x.expect }
  })
}

/** AI に頼む口(このPCの AI・Gemini。答えられなかった頼みは null) */
export type AskJson = (requests: LlmRequest[]) => Promise<(unknown | null)[]>

export interface ScenePlan {
  /** 直した区切り(時刻順。`applySceneMoves` に渡す) */
  moves: SceneMove[]
  /** 聞いた区切りの数・頼んだ数(記録用) */
  asked: number
  requests: number
  /** AI の答えを使わなかった理由(確かめの切れ目を外した = 中身を見分けていない)。使ったときは無い */
  untrusted?: 'missed-control'
}

/**
 * 怪しい区切りを AI に聞いて、直す区切りを決める(3回に分けて頼む: 確かめの切れ目 → 今の区切り → 動かす先の候補)。
 * `ask` が投げたら投げる(中止は呼び出し側で扱う)。答えが無い・食い違うときは直さない
 */
export async function planSceneMoves(
  scenes: readonly Scene[],
  options: SceneOptions,
  ask: AskJson
): Promise<ScenePlan> {
  const questions = suspectBoundaries(scenes, options)
  if (questions.length === 0) return { moves: [], asked: 0, requests: 0 }
  const controls = controlGaps(scenes)
  let requests = 0
  // 1回目: 答えの決まった確かめの切れ目だけを聞く。中身を見分けていない AI(小さいモデル)なら、
  // ここで止める(怪しい区切りの分まで頼まない。CPU の 1.5B で 1 件 3〜5 秒)
  const probe = controls.flatMap((c) => gapRequests(c.all, c.cut))
  requests += probe.length
  const r0 = await ask(probe)
  // 確かめの切れ目を、2通りの頼み方がそろって逆に答えたら(中身によらず同じ言葉を選んでいる)使わない。
  // そろって正しく答えたものが1つも無いときも使わない(食い違うだけの確かめは、位置に寄った答え)
  const control = controls.map((_, i) => agreedVerdict(r0[i * 2], r0[i * 2 + 1]))
  const trusted =
    control.every((v, i) => v === null || v === controls[i].expect) &&
    control.some((v, i) => v === controls[i].expect)
  if (!trusted) return { moves: [], asked: questions.length, requests, untrusted: 'missed-control' }
  // 2回目: 今の区切りは話の途中か
  const first = questions.flatMap((q) => gapRequests(q.all, q.cut))
  requests += first.length
  const r1 = await ask(first)
  const broken = questions.filter((_, i) => agreedVerdict(r1[i * 2], r1[i * 2 + 1]) === 'continues')
  // 短い場面を丸ごと入れて直せる区切りは、新しい切れ目を増やさないので聞き足さない
  const mergeOf = (q: BoundaryQuestion): BoundaryCandidate | undefined =>
    q.candidates.find((c) => c.merge === 'forward') ??
    q.candidates.find((c) => c.merge === 'backward')
  // 3回目: 動かす先(短い場面を入れる以外)の発話の間は一区切りか
  const pending = broken.filter((q) => !mergeOf(q))
  const asks = pending.flatMap((q) =>
    q.candidates.filter((c) => !c.current && !c.merge).map((c) => ({ q, c }))
  )
  const verdicts = new Map<BoundaryCandidate, GapVerdict | null>()
  if (asks.length > 0) {
    const second = asks.flatMap(({ q, c }) => gapRequests(q.all, c.cut))
    requests += second.length
    const r2 = await ask(second)
    asks.forEach(({ c }, i) => verdicts.set(c, agreedVerdict(r2[i * 2], r2[i * 2 + 1])))
  }
  const proposals: SceneMove[] = []
  for (const q of broken) {
    const merge = mergeOf(q)
    if (merge) {
      proposals.push({ at: q.at, to: merge.time })
      continue
    }
    const target = q.candidates
      .filter((c) => !c.current && verdicts.get(c) === 'breaks')
      .sort((x, y) => Math.abs(x.time - q.at) - Math.abs(y.time - q.at) || x.time - y.time)[0]
    if (target) proposals.push({ at: q.at, to: target.time })
  }
  return {
    moves: decideSceneMoves(scenes, questions, proposals, options),
    asked: questions.length,
    requests
  }
}

/**
 * 直しの案から、当てる直しを決める(時刻順)。1つの場面に2つの直しが掛からないよう、前の直しが触った
 * 場面に掛かる直しは採らない。当てられない直し(長さの上限・下限)は `applySceneMoves` と同じ決まりで落とす
 */
export function decideSceneMoves(
  scenes: readonly Scene[],
  questions: readonly BoundaryQuestion[],
  proposals: readonly SceneMove[],
  options: SceneOptions = {}
): SceneMove[] {
  const moves: SceneMove[] = []
  const touched = new Set<number>()
  let current: Scene[] = [...scenes]
  const sorted = [...proposals].sort((x, y) => x.at - y.at)
  for (const p of sorted) {
    const q = questions.find((x) => Math.abs(x.at - p.at) < 1e-6)
    if (!q || !q.candidates.some((c) => !c.current && Math.abs(c.time - p.to) < 1e-6)) continue
    if (touched.has(q.index) || touched.has(q.index + 1)) continue
    const next = applySceneMoves(current, [p], options)
    if (next.applied.length !== 1) continue
    current = next.scenes
    touched.add(q.index)
    touched.add(q.index + 1)
    moves.push(p)
  }
  return moves
}

/**
 * 保存した直しを場面に当てる(作った時も開き直しも同じ)。区切りが見つからない・動かせる先
 * (`boundaryCandidates`)に無い直しは当てない(文字起こしを直して区切りが変わった など)。場面の ID は
 * 時刻順に振り直す(`buildScenes` と同じ s1, s2, …)
 */
export function applySceneMoves(
  scenes: readonly Scene[],
  moves: readonly SceneMove[],
  options: SceneOptions = {}
): { scenes: Scene[]; applied: SceneMove[] } {
  if (moves.length === 0) return { scenes: [...scenes], applied: [] }
  const list: Scene[] = [...scenes]
  const applied: SceneMove[] = []
  for (const m of moves) {
    const i = list.findIndex((s, j) => j + 1 < list.length && Math.abs(s.end - m.at) < 1e-3)
    if (i < 0) continue
    const a = list[i]
    const c = list[i + 1]
    if (a.lines.length === 0 || c.lines.length === 0) continue
    const cand = boundaryCandidates(a, c, options).find(
      (x) => !x.current && Math.abs(x.time - m.to) < 1e-3
    )
    if (!cand) continue
    const lines = [...a.lines, ...c.lines]
    if (cand.merge === 'forward') {
      list.splice(i, 2, { ...a, end: c.end, lines, speech: speechSeconds(lines) })
    } else if (cand.merge === 'backward') {
      list.splice(i, 2, { ...c, start: a.start, lines, speech: speechSeconds(lines) })
    } else {
      const la = lines.slice(0, cand.cut)
      const lc = lines.slice(cand.cut)
      list.splice(
        i,
        2,
        { ...a, end: cand.time, lines: la, speech: speechSeconds(la) },
        { ...c, start: cand.time, lines: lc, speech: speechSeconds(lc) }
      )
    }
    applied.push(m)
  }
  return { scenes: list.map((s, i) => ({ ...s, id: `s${i + 1}` })), applied }
}

/** 記録に出す、直した区切りの説明(「527.2 秒 → 535.9 秒(後ろの短い場面を前の場面へ)」) */
export function describeSceneMove(m: SceneMove, scenes: readonly Scene[]): string {
  const i = scenes.findIndex((s, j) => j + 1 < scenes.length && Math.abs(s.end - m.at) < 1e-3)
  const a = scenes[i]
  const c = scenes[i + 1]
  const how =
    a && c && Math.abs(m.to - c.end) < 1e-3
      ? '後ろの短い場面を前の場面へ'
      : a && c && Math.abs(m.to - a.start) < 1e-3
        ? '前の短い場面を後ろの場面へ'
        : m.to < m.at
          ? '前へ'
          : '後ろへ'
  return `${m.at.toFixed(1)} 秒 → ${m.to.toFixed(1)} 秒(${how})`
}

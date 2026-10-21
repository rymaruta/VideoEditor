import type { EditedTelop, TextOverlay } from '../types'

/**
 * 人の修正を、自動編集の作り直しで上書きしない(計画書 §5.13)。
 *
 * 自動で置いたテロップ(発言テロップ・演出テロップ)は、どの発言・どの提案から作ったかの鍵を持つ。
 * - 人が直したもの(`edited`)は、作り直しても文字と見た目を残す。時刻だけ新しい仮編集に合わせる
 * - 人が消したものは、作り直しても足し直さない(鍵を覚えておく)
 */

/** 自動の発言テロップを、発話のどの部分から作ったか(素材の時刻と、作ったときの文) */
export interface AutoTelopSource {
  start: number
  end: number
  text: string
  /**
   * 文(空白・改行を除く)の1文字ごとの、話している時刻(素材の秒、文字の真ん中)。人が直した・消した
   * 範囲で新しい枚を切り分けるのに使う。無いもの(前の版)は、範囲の中に文字数で割り振る
   */
  times?: number[]
  /**
   * 作ったときのタイムラインの時刻への写し(タイムライン = offset + 素材の秒 / rate。rate は無ければ 1)。
   * 直した・消した範囲で切り分けた枚の時刻を、話している時刻から決めるのに使う(文字数で割り振ると、
   * ゆっくり話した言葉を直した枚が声より 0.7 秒早く消え、残りの枚が声より 0.8 秒早く出ていた)
   */
  offset?: number
  rate?: number
  /**
   * 辞書で直した言葉の文字の並び([何文字目から, 何文字目まで(含まない), 直す前の言葉の最初の文字の
   * 真ん中の時刻, 前の版の時刻の候補の頭])。前の版(01b3ed7)は直した文字をみな1つの時刻(直前に合った
   * 文字の次の元の文字。候補の頭〜最初の文字の時刻のどれか)にして範囲を覚えたので、その範囲がこの時刻を
   * 含むなら、直した言葉を丸ごと当てる(含まないと、消した言葉が戻る・直した文字が2回出る)
   */
  runs?: [number, number, number, number][]
  /**
   * 文字ごとの話している長さ(秒。頭〜終わり = `times` ∓ 長さ/2)。切り分けた枚の時刻を声に合わせる
   * (無いもの(前の版)は、隣の文字との間隔の短い方の半分を受け持つとみなす)
   */
  durs?: number[]
  /** 言いよどみの言葉が枚の境目で分かれて残った切れ端の文字(何文字目か。`TelopChunk.fill`) */
  fill?: number[]
}

/** 発言テロップに付ける、作ったときの元の部分(仮編集が付ける。無いのは前の版で作ったもの) */
export interface WithAutoSource {
  autoSource?: AutoTelopSource
}

/**
 * 読み込んだ元の部分を確かめる(壊れた値は外す)。数でない時刻のまま鍵を作ると `toFixed` で落ちる
 */
export function normalizeAutoSource(raw: unknown): AutoTelopSource | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.start !== 'number' || typeof r.end !== 'number' || typeof r.text !== 'string')
    return undefined
  if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.end < r.start) return undefined
  const times =
    Array.isArray(r.times) && r.times.every((t) => typeof t === 'number' && Number.isFinite(t))
      ? (r.times as number[])
      : undefined
  const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
  return {
    start: r.start,
    end: r.end,
    text: r.text,
    ...(times ? { times: [...times] } : {}),
    ...(finite(r.offset) ? { offset: r.offset } : {}),
    ...(finite(r.rate) && r.rate > 0 ? { rate: r.rate } : {}),
    ...(Array.isArray(r.runs) &&
    r.runs.every(
      (x) => Array.isArray(x) && (x.length === 3 || x.length === 4) && x.every((v) => finite(v))
    )
      ? {
          runs: (r.runs as number[][]).map((x): [number, number, number, number] => [
            x[0],
            x[1],
            x[2],
            x[3] ?? x[2]
          ])
        }
      : {}),
    ...(Array.isArray(r.durs) && r.durs.every((v) => finite(v) && v >= 0)
      ? { durs: [...(r.durs as number[])] }
      : {}),
    ...(Array.isArray(r.fill) && r.fill.every((v) => finite(v))
      ? { fill: [...(r.fill as number[])] }
      : {})
  }
}

/** 覚えておく人の修正(元の部分も覚える。無いのは前の版で覚えたもの) */
type RememberedEdit = EditedTelop & WithAutoSource

// 負の時刻は鍵の読み取り(`keySpan`)で読めないので 0 にそろえる
const spanLabel = (t: number): string => Math.max(0, t).toFixed(3)

/**
 * 自動テロップの鍵。発言テロップは「発話+何枚目」に、作ったときの元の部分(素材の時刻)を添える。
 *
 * 何枚目かだけで覚えると、1行の長さ(覚えた見た目)・辞書が変わって枚の分け方が変わったとき、
 * 直した文字・消した印が別の言葉の枚に付いていた(最後の枚を直して作り直すと、直した文字が
 * 別の部分の枚に乗り、元の言葉と直した言葉が2回出た)。元の部分があれば、時刻の重なりで探し直す
 */
export function autoTelopKey(
  o: Pick<TextOverlay, 'utteranceId' | 'utteranceChunk' | 'effectId'> & WithAutoSource
): string | null {
  if (o.utteranceId) {
    const base = `u:${o.utteranceId}#${o.utteranceChunk ?? 0}`
    const src = o.autoSource
    return src ? `${base}@${spanLabel(src.start)}-${spanLabel(src.end)}` : base
  }
  if (o.effectId) return `e:${o.effectId}`
  return null
}

/** 元の部分を外した鍵(前の版の鍵と同じ形) */
function baseKey(key: string): string {
  const at = key.indexOf('@', key.lastIndexOf('#'))
  return at < 0 ? key : key.slice(0, at)
}

/** 鍵に添えた元の部分(素材の時刻) */
function keySpan(key: string): { utteranceId: string; start: number; end: number } | null {
  const m = /^u:(.+)#\d+@([\d.]+)-([\d.]+)$/.exec(key)
  return m ? { utteranceId: m[1], start: Number(m[2]), end: Number(m[3]) } : null
}

/** 人の修正とみなす変更(文字・見た目・時刻)か */
export function isManualEdit(patch: Partial<TextOverlay>): boolean {
  return ['text', 'style', 'startTime', 'endTime', 'speaker', 'styleId'].some((k) => k in patch)
}

/** 範囲の端の余裕(秒)。鍵の時刻は 1/1000 秒に丸めるので、それより大きく、文字の間隔より小さく */
export const AUTO_SOURCE_MARGIN = 0.002

interface Range {
  start: number
  end: number
}

const inRange = (t: number, r: Range): boolean => t >= r.start - 1e-9 && t <= r.end + 1e-9

interface EditEntry {
  key: string
  rec: RememberedEdit
  /** 今タイムラインにある修正なら、その時刻 */
  at?: Range
  /** 直した部分(素材の時刻)。無いのは前の版の修正(何枚目かで当てる) */
  src?: Range
  utteranceId?: string
  chunk?: number
}

interface Char {
  /** 枚の文の中の位置(空白・改行を含む文字の並びで) */
  pos: number
  /** 話している時刻(素材の秒)。分からなければ null */
  src: number | null
  /**
   * この文字の受け持つ素材の時刻の範囲(隣の文字との真ん中まで。枚の端の文字は枚の範囲の端まで)。
   * 切り分けた枚の範囲にする(真ん中の時刻だけにすると、辞書で直した言葉の後ろ半分が範囲から外れ、
   * 消した言葉がカットを変えたときに直す前の形で戻っていた)
   */
  srcLo: number | null
  srcHi: number | null
  /** 辞書で直した言葉の文字なら、直す前の言葉の最初の文字の時刻と前の版の時刻の候補の頭(`runs`) */
  runT0: number | null
  runG0: number | null
  /** 話している長さ(秒。分からなければ null) */
  dur: number | null
  /** 言いよどみの言葉の切れ端の文字か */
  fill: boolean
  /** タイムラインの頭・終わり(枚の時間を文字数で割り振る) */
  t0: number
  t1: number
  claim?: EditEntry
  dropped?: boolean
}

const flatText = (t: string): string => t.replace(/\s/g, '')

/**
 * 文字が範囲に入るか。話している時刻(文字の真ん中)が入るか、辞書で直した言葉の文字なら、直す前の
 * 言葉の最初の文字の時刻が入るか(前の版はこの時刻で範囲を覚えた。直した言葉は1つのまとまりとして当てる)
 */
const hits = (c: Char, r: Range, oldPoint: boolean): boolean =>
  (c.src !== null && inRange(c.src, r)) ||
  (c.runT0 !== null && inRange(c.runT0, r)) ||
  // 前の版の点のような範囲(直した文字の1つの時刻 ± 0.002 秒)は、その版が付けえた時刻の間に掛かれば当てる。
  // 今の版の短い範囲(長さ 0 の言葉「はい」[3.0, 3.0] の枚)には当てない(隣の辞書の言葉まで消えていた)
  (oldPoint &&
    c.runT0 !== null &&
    c.runG0 !== null &&
    r.end - r.start < OLD_POINT_SEC &&
    r.end >= c.runG0 - 1e-9 &&
    r.start <= c.runT0 + 1e-9)

/** 前の版が辞書で直した文字だけの枚に付けた範囲の幅の上限(1つの時刻 ± 余裕) */
const OLD_POINT_SEC = 0.01

/** 文字の並びの、辞書で直した言葉のまとまり(`AutoTelopSource.runs`) */
function runsOfChars(cs: readonly Char[]): [number, number, number, number][] | undefined {
  const out: [number, number, number, number][] = []
  cs.forEach((c, i) => {
    if (c.runT0 === null) return
    const last = out[out.length - 1]
    if (last && last[1] === i && last[2] === c.runT0) last[1] = i + 1
    else out.push([i, i + 1, c.runT0, c.runG0 ?? c.runT0])
  })
  return out.length > 0 ? out : undefined
}

/** 文字の並びの、話している長さと言いよどみの切れ端(`AutoTelopSource.durs`・`fill`) */
function extrasOfChars(cs: readonly Char[]): { durs?: number[]; fill?: number[] } {
  const fill = cs.map((c, i) => (c.fill ? i : -1)).filter((i) => i >= 0)
  return {
    ...(cs.every((c) => c.dur !== null) ? { durs: cs.map((c) => c.dur!) } : {}),
    ...(fill.length > 0 ? { fill } : {})
  }
}

/**
 * 話している長さを覚えていない枚(前の版)で、文字が長い間の向こうへ受け持つ長さの上限(秒)。
 * 伸ばした語尾(「ね」1.2 秒)の終わりまでは出し、間の真ん中までは延ばさない
 */
const HALF_GAP_CAP = 0.6

/** 枚の文字ごとの時刻 */
function charsOf(n: Omit<TextOverlay, 'id'> & WithAutoSource): { chars: string[]; vis: Char[] } {
  const chars = [...n.text]
  const pos: number[] = []
  chars.forEach((c, i) => {
    if (!/\s/.test(c)) pos.push(i)
  })
  const L = pos.length
  const src = n.autoSource
  const exact = src?.times && src.times.length === L ? src.times : null
  const times = exact
    ? exact
    : src
      ? pos.map((_, k) => src.start + ((src.end - src.start) * (k + 0.5)) / Math.max(1, L))
      : null
  const d = n.endTime - n.startTime
  const runT0: (number | null)[] = pos.map(() => null)
  const runG0: (number | null)[] = pos.map(() => null)
  const durs = exact && src?.durs && src.durs.length === L ? src.durs : null
  const fills = new Set(exact ? (src?.fill ?? []) : [])
  if (exact && src?.runs)
    for (const [f, t, t0, g0] of src.runs)
      for (let k = Math.max(0, f); k < Math.min(L, t); k++) {
        runT0[k] = t0
        runG0[k] = g0 ?? t0
      }
  // 話している時刻が分かれば、文字の頭・終わりのタイムラインの時刻もそこから決める。文字の話している
  // 長さが分かればその頭〜終わり(伸ばした語尾「ね」1.2 秒も、終わりまで出す)、分からなければ(前の版)
  // 前・後それぞれの隣の文字との間の半分(上限あり。長い間の真ん中を境にすると、間の後の枚が声より 0.8 秒
  // 早く出て、間の前の枚が声より 0.8 秒長く残っていた)。枚の最初・最後の文字は枚の頭・終わりまで。
  // 分からなければ枚の時間を文字数で割り振る
  if (exact && src) {
    const rate = src.rate && src.rate > 0 ? src.rate : 1
    const toTl = (t: number): number =>
      src.offset !== undefined ? src.offset + t / rate : n.startTime + (t - src.start) / rate
    const clamp = (t: number): number => Math.min(n.endTime, Math.max(n.startTime, t))
    // 長さが分からなければ、前・後それぞれ隣の文字との間の半分(長い間の向こうへは HALF_GAP_CAP まで)
    const before = exact.map((c, k) =>
      durs ? durs[k] / 2 : k > 0 ? Math.min(Math.max(0, c - exact[k - 1]) / 2, HALF_GAP_CAP) : 0
    )
    const after = exact.map((c, k) =>
      durs ? durs[k] / 2 : k < L - 1 ? Math.min(Math.max(0, exact[k + 1] - c) / 2, HALF_GAP_CAP) : 0
    )
    const t0s: number[] = []
    const t1s: number[] = []
    for (let k = 0; k < L; k++) {
      const a = k === 0 ? n.startTime : clamp(toTl(exact[k] - before[k]))
      const b = k === L - 1 ? n.endTime : clamp(toTl(exact[k] + after[k]))
      t0s.push(Math.max(a, k > 0 ? t1s[k - 1] : -Infinity))
      t1s.push(Math.max(b, t0s[k]))
    }
    return {
      chars,
      vis: pos.map((p, k) => ({
        pos: p,
        src: exact[k],
        srcLo: k === 0 ? Math.min(src.start, exact[0]) : (exact[k - 1] + exact[k]) / 2,
        srcHi: k === L - 1 ? Math.max(src.end, exact[k]) : (exact[k] + exact[k + 1]) / 2,
        runT0: runT0[k],
        runG0: runG0[k],
        dur: durs ? durs[k] : null,
        fill: fills.has(k),
        t0: t0s[k],
        t1: t1s[k]
      }))
    }
  }
  return {
    chars,
    vis: pos.map((p, k) => ({
      pos: p,
      src: times ? times[k] : null,
      srcLo: src ? src.start + ((src.end - src.start) * k) / Math.max(1, L) : null,
      srcHi: src ? src.start + ((src.end - src.start) * (k + 1)) / Math.max(1, L) : null,
      runT0: null,
      runG0: null,
      dur: null,
      fill: false,
      t0: n.startTime + (d * k) / Math.max(1, L),
      t1: n.startTime + (d * (k + 1)) / Math.max(1, L)
    }))
  }
}

/**
 * 作り直したテロップ(`incoming`)に、今あるテロップの人の修正を重ねる。
 * 戻り値は `incoming` と同じ並び(消したものは除く。直した・消した範囲で分けた枚はその位置に入る)。
 *
 * 人の修正・消した印は、**元の発話の時刻の範囲**として当てる(枚の分け方・カットが変わっても、
 * 同じ言葉に当たる)。新しい枚の文字を、話している時刻で
 * 1. 直した範囲に入る文字 → その修正に置き換える(修正は1回だけ。分かれた枚にまたがっても1枚にまとめる)
 * 2. 消した範囲に入る文字 → 出さない
 * 3. ほか → 自動の文字のまま(枚の一部が直した・消した範囲に入るなら、残りだけの枚にする)
 * に分ける。何枚目かで当てたり、枚を丸ごと外したりすると、言葉が2回出る・消えることがあった
 * (2つに分かれた枚の片方を消してカットを戻すと、残した方の言葉まで消えていた)。
 * 前の版の修正(範囲を覚えていない)は、これまでどおり何枚目かで当てる(分かれた枚は全部まとめて)
 */
export function mergeManualTelops<T extends Omit<TextOverlay, 'id'>>(
  existing: readonly TextOverlay[],
  incoming: readonly T[],
  dismissed: ReadonlySet<string>,
  /** 覚えておいた人の修正(今タイムラインに無いものも含む) */
  remembered: Readonly<Record<string, EditedTelop>> = {}
): T[] {
  // 修正を集める(今タイムラインにあるものが新しい)
  const byKey = new Map<string, EditEntry>()
  for (const [key, rec] of Object.entries(remembered)) byKey.set(key, { key, rec })
  for (const o of existing) {
    const key = autoTelopKey(o)
    if (key && o.edited) byKey.set(key, { key, rec: o, at: { start: o.startTime, end: o.endTime } })
  }
  // 同じ枚の、前の版の鍵の修正と範囲つきの鍵の修正は、新しい方だけ(両方を当てると、直し直す前の
  // 古い文字と直し直した文字が両方出ていた)。今タイムラインにある方、無ければ範囲つきの方が新しい
  const spanKeysOf = new Map<string, string[]>()
  for (const key of byKey.keys())
    if (keySpan(key)) spanKeysOf.set(baseKey(key), [...(spanKeysOf.get(baseKey(key)) ?? []), key])
  for (const [base, keys] of spanKeysOf) {
    const legacy = byKey.get(base)
    if (!legacy) continue
    if (legacy.at) for (const k of keys) if (!byKey.get(k)!.at) byKey.delete(k)
    if (!legacy.at || keys.some((k) => byKey.has(k))) byKey.delete(base)
  }

  const dismissedSpans = [...dismissed].map(keySpan).filter((x) => x !== null)
  const dismissedBases = new Set([...dismissed].filter((k) => k.startsWith('u:') && !keySpan(k)))
  const spanDismissed = (utteranceId: string, r: Range): boolean =>
    dismissedSpans.some((d) => {
      const ov = Math.max(0, Math.min(d.end, r.end) - Math.max(d.start, r.start))
      return d.utteranceId === utteranceId && ov > 0 && ov >= 0.5 * (r.end - r.start) - 1e-9
    })

  const edits: EditEntry[] = []
  const effectEdits = new Map<string, EditEntry>()
  for (const e of byKey.values()) {
    if (e.key.startsWith('e:')) {
      if (!dismissed.has(e.key)) effectEdits.set(e.key, e)
      continue
    }
    const m = /^u:(.+)#(\d+)(?:@|$)/.exec(e.key)
    if (!m) continue
    e.utteranceId = m[1]
    e.chunk = Number(m[2])
    const span = keySpan(e.key)
    const src = e.rec.autoSource ?? (span ? { start: span.start, end: span.end } : undefined)
    if (src) e.src = { start: src.start, end: src.end }
    // 直してから消した修正は、作り直しても(隣の枚へ移しても)出さない
    if (dismissed.has(e.key) || dismissedBases.has(baseKey(e.key))) continue
    if (e.src && spanDismissed(e.utteranceId, e.src)) continue
    edits.push(e)
  }
  // 同じ範囲の修正は1つだけ(今タイムラインにある方)。今あるものを先に当てる
  edits.sort((a, b) => Number(!!b.at) - Number(!!a.at))
  const seenSpan = new Set<string>()
  const uniq = edits.filter((e) => {
    if (!e.src) return true
    const id = `${e.utteranceId}@${spanLabel(e.src.start)}-${spanLabel(e.src.end)}`
    if (seenSpan.has(id)) return false
    seenSpan.add(id)
    return true
  })

  // 発話ごとの枚の並び(同じ発話の枚は、最初の枚の位置にまとめて出す)
  const groups = new Map<string, (T & WithAutoSource)[]>()
  const order: (T | string)[] = []
  for (const n0 of incoming) {
    const n = n0 as T & WithAutoSource
    const key = autoTelopKey(n)
    if (!n.utteranceId) {
      if (key && dismissed.has(key)) continue
      const e = key ? effectEdits.get(key) : undefined
      order.push(e ? applyEdit(n, e.rec, n.text === e.rec.text) : n)
      continue
    }
    // 前の版の消した印(何枚目かだけ)は、これまでどおりその番号の枚を出さない(分かれた枚も全部)
    if (dismissedBases.has(`u:${n.utteranceId}#${n.utteranceChunk ?? 0}`)) continue
    if (key && dismissed.has(key)) continue
    const g = groups.get(n.utteranceId)
    if (g) g.push(n)
    else {
      groups.set(n.utteranceId, [n])
      order.push(n.utteranceId)
    }
  }

  const out: T[] = []
  for (const x of order) {
    if (typeof x !== 'string') out.push(x)
    else
      out.push(
        ...carveUtterance(
          groups.get(x)!,
          uniq.filter((e) => e.utteranceId === x),
          dismissedSpans.filter((d) => d.utteranceId === x),
          existing.filter((o) => o.utteranceId === x && !o.edited)
        )
      )
  }
  return out
}

function applyEdit<T extends Omit<TextOverlay, 'id'>>(
  n: T,
  rec: RememberedEdit,
  keepWords: boolean
): T {
  return {
    ...n,
    text: rec.text,
    style: rec.style,
    // スタイルとのつながり・話者も人の修正のとおり(見た目を手で替えてスタイルから外したもの、
    // 話者を消したものを、作り直しでつなぎ直さない。覚えておいた修正はいつも両方を写している)
    styleId: rec.styleId,
    speaker: rec.speaker,
    // 文字を直していれば、単語ごとの時刻(カラオケ表示)は合わなくなるので外す
    words: keepWords ? n.words : undefined,
    edited: true
  }
}

/** 1つの発話の新しい枚を、人の修正・消した範囲で切り分ける */
function carveUtterance<T extends Omit<TextOverlay, 'id'>>(
  pieces: (T & WithAutoSource)[],
  edits: EditEntry[],
  dismissedSpans: readonly Range[],
  existingAuto: readonly TextOverlay[]
): T[] {
  const parsed = pieces.map((n) => ({ n, ...charsOf(n) }))
  const hasSource = parsed.every((p) => p.vis.every((c) => c.src !== null))
  // 今あるテロップと新しい枚が同じタイムラインか(同じ番号の直していない枚が、同じ時刻に、同じ文
  // (またはその一部)で出る)。同じなら前の版の修正を今の時刻の重なりで探せる。違う(ショート・カットを
  // 変えた)なら、時刻の重なりは別の言葉を指すので、これまでどおり何枚目かで当てる
  const sameTimeline = existingAuto.some((o) =>
    pieces.some((p) => {
      if ((p.utteranceChunk ?? 0) !== (o.utteranceChunk ?? 0)) return false
      if (Math.abs(p.startTime - o.startTime) > 0.05) return false
      const a = flatText(o.text)
      const b = flatText(p.text)
      return a.includes(b) || b.includes(a)
    })
  )
  const tMid = (c: Char): number => (c.t0 + c.t1) / 2
  // 前の版の点のような範囲か(短い範囲で、辞書で直した文字以外の今出ている文字の時刻を含まない。
  // 前の版の点の範囲は、辞書で直した文字だけの枚にしか付かなかった)
  const oldPointOf = (r: Range): boolean =>
    r.end - r.start < OLD_POINT_SEC &&
    !parsed.some((p) => p.vis.some((c) => c.runT0 === null && c.src !== null && inRange(c.src, r)))
  const claimWith = (e: EditEntry, test: (c: Char, chunk: number) => boolean): number => {
    let n = 0
    for (const p of parsed)
      for (const c of p.vis)
        if (!c.claim && test(c, p.n.utteranceChunk ?? 0)) {
          c.claim = e
          n++
        }
    return n
  }
  for (const e of edits) {
    if (e.src && hasSource) {
      // 範囲で当てる。範囲の言葉が今は無い(カットで落ちた)なら出さない
      const old = oldPointOf(e.src)
      claimWith(e, (c) => hits(c, e.src!, old))
      continue
    }
    // 前の版の修正(範囲なし)・範囲の分からない枚: 枚の分け方が変わったなら今の時刻の重なりで、
    // 見つからなければ(ショートなど、別のタイムライン)これまでどおり何枚目かで当てる
    if (e.at && sameTimeline && claimWith(e, (c) => inRange(tMid(c), e.at!)) > 0) continue
    claimWith(e, (_, chunk) => chunk === e.chunk)
  }
  // 当てた文字が言いよどみの言葉の切れ端だけ(枚の境目で「えっ|と」に分かれた「と」)の修正は出さない。
  // 直した言葉はもう聞こえないのに、直した文字が 0.3 秒だけ光っていた。その文字は自動の文字に戻す
  // (話した文字は消さない。「そう」「うん」のような言葉そのものは切れ端ではないので、修正を出す)
  for (const e of edits) {
    const mine = parsed.flatMap((p) => p.vis.filter((c) => c.claim === e))
    if (mine.length > 0 && mine.every((c) => c.fill)) for (const c of mine) c.claim = undefined
  }
  const dismissedOld = dismissedSpans.map((d) => oldPointOf(d))
  for (const p of parsed)
    for (const c of p.vis)
      if (!c.claim && c.src !== null && dismissedSpans.some((d, i) => hits(c, d, dismissedOld[i])))
        c.dropped = true

  const out: (T & WithAutoSource)[] = []
  /** 出す枚ごとの、動かしてよい範囲(元の枚の頭〜終わり)と、切り分けて作った枚か */
  const meta: CarveMeta[] = []
  const placed = new Map<
    EditEntry,
    { at: number; host: T & WithAutoSource; chars: Char[]; texts: string[]; wholeHost: boolean }
  >()
  for (const p of parsed) {
    const { n, chars, vis } = p
    if (vis.every((c) => !c.claim && !c.dropped)) {
      out.push(n)
      meta.push({ lo: n.startTime, hi: n.endTime, carved: false, host: n, multi: false })
      continue
    }
    let run: Char[] = []
    const flush = (): void => {
      if (run.length === 0) return
      const first = run[0]
      const last = run[run.length - 1]
      const text = chars
        .slice(first.pos, last.pos + 1)
        .join('')
        .trim()
      const srcs = run.map((c) => c.src)
      const known = srcs.every((t) => t !== null) ? (srcs as number[]) : null
      out.push({
        ...n,
        text,
        startTime: first.t0,
        endTime: last.t1,
        words: n.words?.filter((w) => w.start >= first.t0 - 1e-6 && w.start < last.t1 - 1e-6),
        ...(known
          ? {
              autoSource: {
                start: first.srcLo ?? Math.min(...known) - AUTO_SOURCE_MARGIN,
                end: last.srcHi ?? Math.max(...known) + AUTO_SOURCE_MARGIN,
                text,
                times: known,
                ...(n.autoSource?.offset !== undefined ? { offset: n.autoSource.offset } : {}),
                ...(n.autoSource?.rate !== undefined ? { rate: n.autoSource.rate } : {}),
                ...(runsOfChars(run) ? { runs: runsOfChars(run) } : {}),
                ...extrasOfChars(run)
              }
            }
          : {})
      })
      meta.push({ lo: n.startTime, hi: n.endTime, carved: true, host: n, multi: false })
      run = []
    }
    for (const c of vis) {
      if (c.claim) {
        flush()
        const e = c.claim
        const got = placed.get(e)
        if (got) {
          got.chars.push(c)
          got.texts.push(chars[c.pos])
          if (got.host !== n) got.wholeHost = false
          const m = meta[got.at]
          m.lo = Math.min(m.lo, n.startTime)
          m.hi = Math.max(m.hi, n.endTime)
          if (m.host !== n) m.multi = true
        } else {
          placed.set(e, {
            at: out.length,
            host: n,
            chars: [c],
            texts: [chars[c.pos]],
            wholeHost: vis.every((v) => v.claim === e)
          })
          out.push(n) // 後で修正に置き換える
          meta.push({ lo: n.startTime, hi: n.endTime, carved: true, host: n, multi: false })
        }
      } else if (c.dropped) flush()
      else run.push(c)
    }
    flush()
  }
  for (const [e, x] of placed) {
    const srcs = x.chars.map((c) => c.src)
    const known = srcs.every((t) => t !== null) ? (srcs as number[]) : null
    const keepWords = x.wholeHost && e.rec.text === x.host.text
    const startTime = Math.min(...x.chars.map((c) => c.t0))
    const endTime = Math.max(...x.chars.map((c) => c.t1))
    // 範囲を覚えていない修正は、当てた文字の範囲を覚えさせる(次からは範囲で当たる)。
    // 枚を丸ごと当てたなら、その枚の範囲のまま(文字の時刻の分からない枚でも、隣の枚の文字を含まない)
    const hosts = parsed.filter((p) => p.vis.some((c) => c.claim === e))
    const wholePieces =
      hosts.length > 0 && hosts.every((p) => p.n.autoSource && p.vis.every((c) => c.claim === e))
    const autoSource: AutoTelopSource | undefined =
      e.rec.autoSource ??
      (wholePieces
        ? {
            start: Math.min(...hosts.map((p) => p.n.autoSource!.start)),
            end: Math.max(...hosts.map((p) => p.n.autoSource!.end)),
            text: x.texts.join(''),
            ...(known ? { times: known } : {})
          }
        : known
          ? {
              start: Math.min(...x.chars.map((c) => c.srcLo ?? c.src!)),
              end: Math.max(...x.chars.map((c) => c.srcHi ?? c.src!)),
              text: x.texts.join(''),
              times: known,
              ...(runsOfChars(x.chars) ? { runs: runsOfChars(x.chars) } : {}),
              ...extrasOfChars(x.chars)
            }
          : x.host.autoSource)
    const edited = applyEdit(
      { ...x.host, startTime, endTime, ...(autoSource ? { autoSource } : {}) },
      e.rec,
      keepWords
    )
    if (keepWords) {
      edited.startTime = x.host.startTime
      edited.endTime = x.host.endTime
      meta[x.at].carved = false
    }
    out[x.at] = edited
  }
  return settleCarved(out, meta)
}

interface CarveMeta {
  lo: number
  hi: number
  carved: boolean
  /** どの元の枚から作ったか(違う元の枚の間にはカットがありうるので、つながない) */
  host: unknown
  /** 2枚以上の元の枚にまたがる(直した言葉) */
  multi: boolean
}

/** 切り分けた枚の最短の長さ(秒)。仮編集もこれより短い枚は出さない */
export const MIN_CARVED_SEC = 0.3

/**
 * 切り分けて短くなった枚(直した・消した範囲の残りの数文字)を読める長さにする。7,000 回の作り直しで
 * 0.3 秒未満の枚が 246 枚(最短 0.10 秒)あり、一瞬光って消えていた。言葉は落とさずに
 * 1. 元の枚の範囲の中で、前後の空いている所へ延ばす
 * 2. 足りなければ、前後の枚の余り(0.3 秒を超える分)をもらう
 * 3. それでも足りない自動の枚は、続いている隣の自動の枚とつなぐ
 */
function settleCarved<T extends Omit<TextOverlay, 'id'> & WithAutoSource>(
  items: T[],
  meta: CarveMeta[]
): T[] {
  // 確認(終わり - 頭 < 0.3)に丸めの誤差で掛からないよう、ほんの少し長く
  const MIN = MIN_CARVED_SEC + 1e-6
  const order = items.map((_, i) => i).sort((a, b) => items[a].startTime - items[b].startTime)
  let list = order.map((i) => ({ t: { ...items[i] }, m: meta[i] }))
  const dur = (x: { t: T }): number => x.t.endTime - x.t.startTime
  for (let i = 0; i < list.length; i++) {
    const x = list[i]
    if (!x.m.carved || dur(x) >= MIN_CARVED_SEC) continue
    const prev = list[i - 1]
    const next = list[i + 1]
    const hiEnd = Math.min(x.m.hi, next ? next.t.startTime : Infinity)
    x.t.endTime = Math.max(x.t.endTime, Math.min(hiEnd, x.t.startTime + MIN))
    const loStart = Math.max(x.m.lo, prev ? prev.t.endTime : -Infinity)
    x.t.startTime = Math.min(x.t.startTime, Math.max(loStart, x.t.endTime - MIN))
    if (dur(x) < MIN_CARVED_SEC) {
      // 続いている枚(隙間なく並ぶ)の境目をずらして、それぞれ 0.3 秒ずつにする。境目は、前の枚の
      // 動かしてよい範囲の終わり・後の枚の範囲の頭を越えない(元の枚の外 = カットの向こうへ出さない)
      // まとまりは、隙間なく続く枚と、同じ元の枚から作った枚(声の間の隙間はあってよい。境目を動かす
      // ときは隙間を埋める)
      const linked = (p: (typeof list)[number], q: (typeof list)[number]): boolean =>
        Math.abs(p.t.endTime - q.t.startTime) < 1e-6 ||
        (q.t.startTime >= p.t.endTime - 1e-6 &&
          (p.m.host === q.m.host ||
            (p.m.multi && q.t.startTime < p.m.hi - 1e-6) ||
            (q.m.multi && p.t.endTime > q.m.lo + 1e-6)))
      let a = i
      let z = i
      while (a > 0 && linked(list[a - 1], list[a])) a--
      while (z < list.length - 1 && linked(list[z], list[z + 1])) z++
      const block = list.slice(a, z + 1)
      const n = block.length
      const bounds = [
        block[0].t.startTime,
        ...block.slice(1).map((y) => y.t.startTime),
        block[n - 1].t.endTime
      ]
      // 足りなければ、まとまり全体を前後の空いている所(元の枚の範囲の中)へ広げる
      if (bounds[n] - bounds[0] < MIN * n) {
        const before = a > 0 ? list[a - 1].t.endTime : -Infinity
        bounds[0] = Math.min(bounds[0], Math.max(block[0].m.lo, before, bounds[n] - MIN * n))
      }
      if (bounds[n] - bounds[0] < MIN * n) {
        const after = z < list.length - 1 ? list[z + 1].t.startTime : Infinity
        bounds[n] = Math.max(bounds[n], Math.min(block[n - 1].m.hi, after, bounds[0] + MIN * n))
      }
      // 0.3 秒ずつ入りきらないなら、入る長さで等しく(長さ 0 の枚を残さない)
      const fit = (target: number): number[] | null => {
        // 後ろから、各境目の上限(後の枚がそれぞれ target 入り、前の枚の範囲の終わりを越えない)
        const cap = [...bounds]
        for (let k = n - 1; k >= 1; k--) cap[k] = Math.min(cap[k + 1] - target, block[k - 1].m.hi)
        const next = [...bounds]
        for (let k = 1; k < n; k++) {
          const floor = Math.max(next[k - 1] + target, block[k].m.lo)
          if (floor > cap[k] + 1e-9) return null
          next[k] = Math.min(cap[k], Math.max(floor, bounds[k]))
        }
        return next
      }
      let next = fit(MIN)
      if (!next) {
        // 入らなければ、まとまりの頭・終わりを前後の空いている所(元の枚の範囲の中)いっぱいまで広げて試す
        const before = a > 0 ? list[a - 1].t.endTime : -Infinity
        const after = z < list.length - 1 ? list[z + 1].t.startTime : Infinity
        bounds[0] = Math.min(bounds[0], Math.max(block[0].m.lo, before))
        bounds[n] = Math.max(bounds[n], Math.min(block[n - 1].m.hi, after))
        // 0.3 秒ずつ入りきらないなら、入るいちばん長い長さでそろえる(元の枚の境目で動かせない所が
        // あっても、長さ 0 の枚を残さない)
        let target: number | null = fit(MIN) ? MIN : null
        if (target === null) {
          let lo = 0
          let hi = MIN
          for (let k = 0; k < 30; k++) {
            const mid = (lo + hi) / 2
            if (fit(mid)) lo = mid
            else hi = mid
          }
          target = lo > 1e-6 ? lo : null
        }
        next = target === null ? null : fit(target)
        // 広げすぎた分は戻す(頭・終わりの枚は、要る長さだけ空いている所へ出す)
        if (next && target !== null) {
          next[n] = Math.min(next[n], Math.max(block[n - 1].t.endTime, next[n - 1] + target))
          next[0] = Math.max(next[0], Math.min(block[0].t.startTime, next[1] - target))
        }
      }
      if (next) {
        block.forEach((y, k) => {
          if (
            Math.abs(y.t.startTime - next[k]) > 1e-9 ||
            Math.abs(y.t.endTime - next[k + 1]) > 1e-9
          )
            y.m.carved = true
          y.t.startTime = next[k]
          y.t.endTime = next[k + 1]
        })
      }
    }
    if (dur(x) >= MIN_CARVED_SEC || x.t.edited) continue
    // 続いている隣の自動の枚とつなぐ(同じ発話・話者。文字は前から順に)
    const join = (a: { t: T; m: (typeof meta)[number] }, b: typeof a): typeof a => {
      const sa = a.t.autoSource
      const sb = b.t.autoSource
      // 英数字どうしは空けてつなぐ(「Good」「morning」を「Goodmorning」にしない)
      const sep = /[A-Za-z0-9]$/.test(a.t.text) && /^[A-Za-z0-9]/.test(b.t.text) ? ' ' : ''
      const text = `${a.t.text}${sep}${b.t.text}`
      const times = sa?.times && sb?.times ? [...sa.times, ...sb.times] : undefined
      const shift = sa?.times?.length ?? 0
      const durs = sa?.durs && sb?.durs ? [...sa.durs, ...sb.durs] : undefined
      const fill = [...(sa?.fill ?? []), ...(sb?.fill ?? []).map((i) => i + shift)]
      const runs = [
        ...(sa?.runs ?? []),
        ...(sb?.runs ?? []).map(([f, t, t0, g0]): [number, number, number, number] => [
          f + shift,
          t + shift,
          t0,
          g0
        ])
      ]
      return {
        t: {
          ...a.t,
          text,
          endTime: b.t.endTime,
          words: a.t.words && b.t.words ? [...a.t.words, ...b.t.words] : undefined,
          ...(sa && sb
            ? {
                autoSource: {
                  ...sa,
                  start: Math.min(sa.start, sb.start),
                  end: Math.max(sa.end, sb.end),
                  text,
                  ...(times ? { times } : {}),
                  ...(runs.length > 0 ? { runs } : {}),
                  ...(durs ? { durs } : { durs: undefined }),
                  ...(fill.length > 0 ? { fill } : { fill: undefined })
                }
              }
            : {})
        },
        m: { ...a.m, lo: Math.min(a.m.lo, b.m.lo), hi: Math.max(a.m.hi, b.m.hi), carved: true }
      }
    }
    // 同じ元の枚から切り分けた枚どうしだけ(違う元の枚の間にはカットがありうる)
    const joinable = (a: typeof x | undefined): boolean =>
      !!a &&
      !a.t.edited &&
      a.m.host === x.m.host &&
      !a.m.multi &&
      !x.m.multi &&
      a.t.speaker === x.t.speaker &&
      Math.abs(
        (a === prev ? a.t.endTime : a.t.startTime) - (a === prev ? x.t.startTime : x.t.endTime)
      ) < 0.05
    if (joinable(next) && (!joinable(prev) || dur(next) <= dur(prev))) {
      list = [...list.slice(0, i), join(x, next!), ...list.slice(i + 2)]
      i--
    } else if (joinable(prev)) {
      list = [...list.slice(0, i - 1), join(prev!, x), ...list.slice(i + 1)]
      i -= 2
    }
  }
  return list.map((x) => x.t)
}

/** 今あるテロップの人の修正を、覚えておいた修正に重ねる(新しい修正が勝つ) */
export function rememberEditedTelops(
  existing: readonly TextOverlay[],
  remembered: Readonly<Record<string, EditedTelop>> | undefined
): Record<string, EditedTelop> | undefined {
  const out: Record<string, EditedTelop> = { ...(remembered ?? {}) }
  // 同じ範囲の鍵の索引(修正ごとに全部の鍵を見直すと、修正の数の二乗の手間になる)
  const sameSpanId = (x: { utteranceId: string; start: number; end: number }): string =>
    `${x.utteranceId}@${spanLabel(x.start)}-${spanLabel(x.end)}`
  const bySpan = new Map<string, string[]>()
  for (const k of Object.keys(out)) {
    const x = keySpan(k)
    if (x) bySpan.set(sameSpanId(x), [...(bySpan.get(sameSpanId(x)) ?? []), k])
  }
  for (const o of existing) {
    const key = autoTelopKey(o)
    if (!key || !o.edited) continue
    const src = (o as TextOverlay & WithAutoSource).autoSource
    const rec: RememberedEdit = {
      text: o.text,
      style: o.style,
      ...(o.styleId !== undefined ? { styleId: o.styleId } : {}),
      ...(o.speaker !== undefined ? { speaker: o.speaker } : {}),
      // 元の部分も覚える(枚の分け方が変わっても、同じ言葉の枚へ当て直せるように)
      ...(src ? { autoSource: src } : {})
    }
    // 同じ枚の前の版の鍵(何枚目かだけ)・同じ範囲の別の鍵は消す。残すと、直し直す前の古い文字が
    // 作り直しで当たる(当て直した修正は、出す位置の枚の番号が変わるので、同じ範囲でも鍵が変わる)
    const base = baseKey(key)
    if (base !== key) delete out[base]
    const span = keySpan(key)
    if (span) {
      const id = sameSpanId(span)
      for (const k of bySpan.get(id) ?? []) if (k !== key) delete out[k]
      bySpan.set(id, [key])
    }
    out[key] = rec
  }
  return Object.keys(out).length > 0 ? out : undefined
}

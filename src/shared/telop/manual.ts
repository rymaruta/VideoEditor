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
}

/** 発言テロップに付ける、作ったときの元の部分(仮編集が付ける。無いのは前の版で作ったもの) */
export interface WithAutoSource {
  autoSource?: AutoTelopSource
}

/** 覚えておく人の修正(元の部分も覚える。無いのは前の版で覚えたもの) */
type RememberedEdit = EditedTelop & WithAutoSource

const spanLabel = (t: number): string => t.toFixed(3)

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

const overlapOf = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

/** 重なりとみなす下限(秒)。隣の枚と境目が触れているだけのものは数えない */
const OVERLAP_EPS = 0.01

interface Edit {
  rec: RememberedEdit
  /** 今タイムラインにある修正なら、その時刻(元の部分を覚えていない前の版の修正を、時刻で探す) */
  at?: { start: number; end: number }
}

interface Piece<T> {
  n: T & WithAutoSource
  edited: boolean
}

/**
 * 作り直したテロップ(`incoming`)に、今あるテロップの人の修正を重ねる。
 * 戻り値は `incoming` と同じ並び(消したものは除く)。
 *
 * 枚の分け方が変わったとき(元の部分の鍵が合わない)は、直した枚の元の部分と重なる新しい枚を探し、
 * 直した文字をそこへ1回だけ出す。直した部分と同じ言葉の新しい枚は外し、直した部分の外の言葉は
 * 残す(言葉が2回出ない・消えない)。元の文で位置が合わせられないときは、いちばん重なる枚に出し、
 * 大半(半分以上)が直した部分に入る枚を外す。消した印も、元の部分と大半が重なる枚を足さない
 */
export function mergeManualTelops<T extends Omit<TextOverlay, 'id'>>(
  existing: readonly TextOverlay[],
  incoming: readonly T[],
  dismissed: ReadonlySet<string>,
  /** 覚えておいた人の修正(今タイムラインに無いものも含む) */
  remembered: Readonly<Record<string, EditedTelop>> = {}
): T[] {
  const edits = new Map<string, Edit>()
  for (const [key, rec] of Object.entries(remembered)) edits.set(key, { rec })
  for (const o of existing) {
    const key = autoTelopKey(o)
    if (key && o.edited) edits.set(key, { rec: o, at: { start: o.startTime, end: o.endTime } })
  }
  // 同じ元の部分の修正は1つだけ(枚を移した修正は、前の鍵でも覚えている。今タイムラインにある方を使う)
  const bySource = new Map<string, string>()
  for (const [key, e] of edits) {
    const span = keySpan(key)
    if (!span) continue
    const id = `${span.utteranceId}@${spanLabel(span.start)}-${spanLabel(span.end)}`
    const prev = bySource.get(id)
    if (prev !== undefined && edits.get(prev)!.at && !e.at) {
      edits.delete(key)
      continue
    }
    if (prev !== undefined) edits.delete(prev)
    bySource.set(id, key)
  }
  const dismissedSpans = [...dismissed].map(keySpan).filter((s) => s !== null)

  // 枚の分け方が変わった発話(今ある直していない枚の文が、同じ番号の新しい枚と違う)
  const incomingText = new Map<string, string>()
  for (const n of incoming) {
    const k = n.utteranceId ? `${n.utteranceId}#${n.utteranceChunk ?? 0}` : null
    if (k && !incomingText.has(k)) incomingText.set(k, n.text)
  }
  const rechunked = new Set<string>()
  for (const o of existing) {
    if (!o.utteranceId || o.edited) continue
    if (incomingText.get(`${o.utteranceId}#${o.utteranceChunk ?? 0}`) !== o.text)
      rechunked.add(o.utteranceId)
  }

  const used = new Set<Edit>()
  const apply = (n: T & WithAutoSource, e: Edit): T & WithAutoSource => {
    used.add(e)
    const sameText = e.rec.text === n.text
    return {
      ...n,
      text: e.rec.text,
      style: e.rec.style,
      // スタイルとのつながり・話者も人の修正のとおり(見た目を手で替えてスタイルから外したもの、
      // 話者を消したものを、作り直しでつなぎ直さない。覚えておいた修正はいつも両方を写している)
      styleId: e.rec.styleId,
      speaker: e.rec.speaker,
      // 文字を直していれば、単語ごとの時刻(カラオケ表示)は合わなくなるので外す
      words: sameText ? n.words : undefined,
      edited: true
    }
  }

  // 発話ごとの枚の並び(同じ発話の枚は、最初の枚の位置にまとめて出す)
  const groups = new Map<string, Piece<T>[]>()
  const order: (Piece<T> | string)[] = []
  for (const n0 of incoming) {
    const n = n0 as T & WithAutoSource
    const key = autoTelopKey(n)
    const base = key ? baseKey(key) : null
    if (key && (dismissed.has(key) || (base !== key && dismissed.has(base!)))) continue
    const src = n.autoSource
    if (
      src &&
      n.utteranceId &&
      dismissedSpans.some(
        (d) =>
          d.utteranceId === n.utteranceId &&
          overlapOf(d.start, d.end, src.start, src.end) > OVERLAP_EPS &&
          overlapOf(d.start, d.end, src.start, src.end) >= 0.5 * (src.end - src.start)
      )
    )
      continue
    // 前の版で覚えた修正(元の部分なし)は、これまでどおり何枚目かで当てる。ただし今タイムラインにあって、
    // 枚の分け方が変わった発話なら、何枚目かは別の言葉を指すので、下で時刻の重なりで探す
    const byIndex = (x: Edit | undefined): Edit | undefined =>
      x && !x.rec.autoSource && !(x.at && rechunked.has(n.utteranceId ?? '')) ? x : undefined
    let e = key ? edits.get(key) : undefined
    if (e && !e.rec.autoSource && n.utteranceId) e = byIndex(e)
    if (!e && base && base !== key) e = byIndex(edits.get(base))
    const piece: Piece<T> =
      e && !used.has(e) ? { n: apply(n, e), edited: true } : { n, edited: false }
    if (!n.utteranceId) {
      order.push(piece)
      continue
    }
    const g = groups.get(n.utteranceId)
    if (g) g.push(piece)
    else {
      groups.set(n.utteranceId, [piece])
      order.push(n.utteranceId)
    }
  }

  // 鍵の合わなかった修正を、発話の中で元の部分と重なる枚へ当て直す
  for (const [key, e] of edits) {
    if (used.has(e) || !key.startsWith('u:')) continue
    const span = keySpan(key)
    const utteranceId = span?.utteranceId ?? /^u:(.+)#\d+$/.exec(key)?.[1]
    if (!utteranceId) continue
    const pieces = groups.get(utteranceId)
    if (!pieces) continue
    if (span && e.rec.autoSource) {
      // 元の部分(素材の時刻)で探す
      relocateEdit(pieces, e, span, (p) => p.n.autoSource ?? null, e.rec.autoSource.text, apply)
    } else if (e.at && rechunked.has(utteranceId)) {
      // 前の版の修正: 今タイムラインにある時刻で探す
      relocateEdit(
        pieces,
        e,
        e.at,
        (p) => ({ start: p.n.startTime, end: p.n.endTime }),
        undefined,
        apply
      )
    }
  }

  const out: T[] = []
  for (const x of order) {
    if (typeof x !== 'string') out.push(x.n)
    else for (const p of groups.get(x)!) out.push(p.n)
  }
  return out
}

/** 空白・改行を除いた文字の、元の文での位置 */
function visibleIndex(text: string): { chars: string[]; at: number[] } {
  const chars = [...text]
  const at: number[] = []
  chars.forEach((c, i) => {
    if (!/\s/.test(c)) at.push(i)
  })
  return { chars, at }
}

/**
 * 修正 `e` を、元の部分 `span` と重なる枚へ当てる(`pieces` を書き換える)。
 * `origText`(直す前の文)が分かれば、重なる枚をつないだ文の中で直した部分を探し、その前後の言葉は
 * 残して、直した部分だけを直した文字の1枚にする
 */
function relocateEdit<T extends Omit<TextOverlay, 'id'>>(
  pieces: Piece<T>[],
  e: Edit,
  span: { start: number; end: number },
  coords: (p: Piece<T>) => { start: number; end: number } | null,
  origText: string | undefined,
  apply: (n: T & WithAutoSource, e: Edit) => T & WithAutoSource
): void {
  const cand = pieces
    .map((p, i) => ({ p, i, c: coords(p) }))
    .filter(
      (x): x is { p: Piece<T>; i: number; c: { start: number; end: number } } =>
        !x.p.edited &&
        x.c !== null &&
        overlapOf(x.c.start, x.c.end, span.start, span.end) > OVERLAP_EPS
    )
  if (cand.length === 0) return
  const withSource = (n: T & WithAutoSource): T & WithAutoSource =>
    e.rec.autoSource ? { ...n, autoSource: e.rec.autoSource } : n

  // 重なる枚をつないだ文(空白・改行を除く)の中で、直した部分 [p, q) を決める。
  // 直す前の文が分かれば、その文の位置。分からない(前の版の修正)・見つからない(辞書を替えた)ときは、
  // 元の部分の頭・終わりの時刻を、枚の中の文字の位置へ割り振って決める(言葉の時刻は文字数で按分して
  // いるので、ほぼ言葉の境目に当たる)。枚を丸ごと外すと、直した部分の外の言葉まで消えていた
  const vis = cand.map((x) => visibleIndex(x.p.n.text))
  const lens = vis.map((v) => v.at.length)
  const starts = lens.map((_, i) => lens.slice(0, i).reduce((t, l) => t + l, 0))
  const joined = vis.map((v) => v.at.map((k) => v.chars[k]).join('')).join('')
  const target = origText !== undefined ? origText.replace(/\s/g, '') : ''
  let p = target ? joined.indexOf(target) : -1
  let q = p + target.length
  if (p < 0) {
    const posAt = (t: number): number => {
      const ci = cand.findIndex((x) => t < x.c.end - 1e-6)
      const i = ci < 0 ? cand.length - 1 : ci
      const c = cand[i].c
      const r = c.end > c.start ? (t - c.start) / (c.end - c.start) : 1
      return starts[i] + Math.round(lens[i] * Math.min(1, Math.max(0, r)))
    }
    p = posAt(span.start)
    q = Math.max(p + 1, posAt(span.end))
  }
  const replaced: Piece<T>[] = []
  cand.forEach((x, ci) => {
    const v = vis[ci]
    const len = lens[ci]
    const g0 = starts[ci]
    const g1 = g0 + len
    const n = x.p.n
    const timeAt = (k: number): number =>
      n.startTime + ((n.endTime - n.startTime) * k) / Math.max(1, len)
    const srcAt = (k: number): number | null =>
      n.autoSource
        ? n.autoSource.start + ((n.autoSource.end - n.autoSource.start) * k) / Math.max(1, len)
        : null
    const part = (k0: number, k1: number): Piece<T> | null => {
      const from = k0 === 0 ? 0 : v.at[k0]
      const to = k1 >= len ? v.chars.length : v.at[k1]
      const text = v.chars.slice(from, to).join('').trim()
      if (!text) return null
      const a = timeAt(k0)
      const b = timeAt(k1)
      const s0 = srcAt(k0)
      const s1 = srcAt(k1)
      return {
        n: {
          ...n,
          text,
          startTime: a,
          endTime: b,
          words: n.words?.filter((w) => w.start >= a - 1e-6 && w.start < b - 1e-6),
          ...(s0 !== null && s1 !== null ? { autoSource: { start: s0, end: s1, text } } : {})
        },
        edited: false
      }
    }
    if (g1 <= p || g0 >= q) {
      replaced.push(x.p)
      return
    }
    if (g0 < p) {
      const before = part(0, p - g0)
      if (before) replaced.push(before)
    }
    if (g0 <= p && p < g1) {
      // 直した部分の終わりの時刻(終わりのある枚の中の位置)
      const cj = Math.max(
        0,
        starts.findIndex((st, j) => q <= st + lens[j])
      )
      const last = cand[cj].p.n
      const endAt =
        last.startTime +
        ((last.endTime - last.startTime) * (q - starts[cj])) / Math.max(1, lens[cj])
      replaced.push({
        n: withSource({ ...apply(n, e), startTime: timeAt(p - g0), endTime: endAt }),
        edited: true
      })
    }
    if (g1 > q) {
      const after = part(q - g0, len)
      if (after) replaced.push(after)
    }
  })
  const first = cand[0].i
  const lastIndex = cand[cand.length - 1].i
  // 重ならない枚が間に挟まっていても並びは崩さない(重なる枚は続いている)
  const between = pieces.slice(first, lastIndex + 1).filter((x) => !cand.some((c) => c.p === x))
  pieces.splice(first, lastIndex - first + 1, ...replaced, ...between)
}

/** 今あるテロップの人の修正を、覚えておいた修正に重ねる(新しい修正が勝つ) */
export function rememberEditedTelops(
  existing: readonly TextOverlay[],
  remembered: Readonly<Record<string, EditedTelop>> | undefined
): Record<string, EditedTelop> | undefined {
  const out: Record<string, EditedTelop> = { ...(remembered ?? {}) }
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
    out[key] = rec
  }
  return Object.keys(out).length > 0 ? out : undefined
}

import type { EditedTelop, TextOverlay } from '../types'

/**
 * 人の修正を、自動編集の作り直しで上書きしない(計画書 §5.13)。
 *
 * 自動で置いたテロップ(発言テロップ・演出テロップ)は、どの発言・どの提案から作ったかの鍵を持つ。
 * - 人が直したもの(`edited`)は、作り直しても文字と見た目を残す。時刻だけ新しい仮編集に合わせる
 * - 人が消したものは、作り直しても足し直さない(鍵を覚えておく)
 */
export function autoTelopKey(
  o: Pick<TextOverlay, 'utteranceId' | 'utteranceChunk' | 'effectId'>
): string | null {
  if (o.utteranceId) return `u:${o.utteranceId}#${o.utteranceChunk ?? 0}`
  if (o.effectId) return `e:${o.effectId}`
  return null
}

/** 人の修正とみなす変更(文字・見た目・時刻)か */
export function isManualEdit(patch: Partial<TextOverlay>): boolean {
  return ['text', 'style', 'startTime', 'endTime', 'speaker', 'styleId'].some((k) => k in patch)
}

/**
 * 作り直したテロップ(`incoming`)に、今あるテロップの人の修正を重ねる。
 * 戻り値は `incoming` と同じ並び(消したものは除く)。
 */
export function mergeManualTelops<T extends Omit<TextOverlay, 'id'>>(
  existing: readonly TextOverlay[],
  incoming: readonly T[],
  dismissed: ReadonlySet<string>,
  /** 覚えておいた人の修正(今タイムラインに無いものも含む) */
  remembered: Readonly<Record<string, EditedTelop>> = {}
): T[] {
  const edited = new Map<string, EditedTelop>(Object.entries(remembered))
  for (const o of existing) {
    const key = autoTelopKey(o)
    if (key && o.edited) edited.set(key, o)
  }
  const out: T[] = []
  for (const n of incoming) {
    const key = autoTelopKey(n)
    if (key && dismissed.has(key)) continue
    const mine = key ? edited.get(key) : undefined
    if (!mine) {
      out.push(n)
      continue
    }
    const sameText = mine.text === n.text
    out.push({
      ...n,
      text: mine.text,
      style: mine.style,
      ...(mine.styleId !== undefined ? { styleId: mine.styleId } : {}),
      ...(mine.speaker !== undefined ? { speaker: mine.speaker } : {}),
      // 文字を直していれば、単語ごとの時刻(カラオケ表示)は合わなくなるので外す
      words: sameText ? n.words : undefined,
      edited: true
    })
  }
  return out
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
    out[key] = {
      text: o.text,
      style: o.style,
      ...(o.styleId !== undefined ? { styleId: o.styleId } : {}),
      ...(o.speaker !== undefined ? { speaker: o.speaker } : {})
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

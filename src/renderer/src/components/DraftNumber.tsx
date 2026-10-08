import { useState } from 'react'

/**
 * 打っている途中の値は欄の中だけに置き、確定(Enter・欄を離れる)したときだけ反映する数値の欄。
 * Esc で打つ前の値に戻す。空欄・数でない値は反映しない。
 *
 * 1 文字ごとに反映すると、打ちかけの値で値が一度変わる:
 * - クリップの長さ(「28」を打つ途中の「2」)でクリップが一度縮み、本編に付いて動く
 *   自動のテロップ・効果音が縮んだ区間の外として消えていた(伸ばし直しても戻らない)
 * - 範囲で丸める欄(テロップの終わり・音のアウト点)は、打った 1 文字目が丸められてから
 *   次の文字が続くので、「12」が「5.12」になっていた
 * - 欄を空にした瞬間に 0 として反映され、テロップ・音が 0 秒へ飛んでいた
 */
export function DraftNumber({
  value,
  min,
  max,
  step,
  onCommit,
  className,
  ariaLabel
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onCommit: (v: number) => void
  className?: string
  ariaLabel?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const v = Number(draft)
    setDraft(null)
    if (draft.trim() !== '' && Number.isFinite(v)) onCommit(v)
  }
  return (
    <input
      type="number"
      className={className}
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={draft ?? String(Number(value.toFixed(2)))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') {
          setDraft(null)
          // 打ちかけを戻すだけ。ダイアログ・画面まで閉じない
          if (draft !== null) e.stopPropagation()
        }
      }}
    />
  )
}

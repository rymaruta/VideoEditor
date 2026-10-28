import { useState } from 'react'
import { formatTimecode, parseTimecode } from '../lib/timelineRuler'

/**
 * タイムコード(HH:MM:SS:FF)の入力欄。打って Enter で決める。Esc・外へ出ると今の値へ戻す。
 * 打っている間は値が動いても(再生中など)書き換えない。読めない字は赤い枠で知らせ、決めない。
 * 値は min〜max に収めて渡す
 */
export function TimecodeField({
  time,
  fps,
  min = 0,
  max,
  onCommit,
  label,
  className = ''
}: {
  time: number
  fps: number
  min?: number
  max?: number
  onCommit: (t: number) => void
  /** 読み上げの名前 */
  label: string
  className?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const [invalid, setInvalid] = useState(false)
  const shown = draft ?? formatTimecode(time, fps)
  return (
    <input
      className={`tc timecode-field ${className} ${invalid ? 'invalid' : ''}`}
      aria-label={label}
      aria-invalid={invalid || undefined}
      spellCheck={false}
      value={shown}
      onFocus={(e) => {
        setDraft(formatTimecode(time, fps))
        e.currentTarget.select()
      }}
      onChange={(e) => {
        setDraft(e.target.value)
        setInvalid(false)
      }}
      onBlur={() => {
        setDraft(null)
        setInvalid(false)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          setDraft(null)
          setInvalid(false)
          e.currentTarget.blur()
          return
        }
        if (e.key !== 'Enter') return
        const t = parseTimecode(draft ?? '', fps)
        if (t === null) {
          setInvalid(true)
          return
        }
        onCommit(Math.max(min, max === undefined ? t : Math.min(max, t)))
        setDraft(null)
        e.currentTarget.blur()
      }}
    />
  )
}

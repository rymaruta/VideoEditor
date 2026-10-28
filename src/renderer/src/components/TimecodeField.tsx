import { useState } from 'react'
import { formatTimecode, timecodeEntryValue } from '../lib/timelineRuler'

/**
 * タイムコード(HH:MM:SS:FF。`12.5` のように `.` を含めば秒)の入力欄。打って Enter で決める
 * (開いたときのまま Enter を押しても決めない)。Esc・外へ出ると今の値へ戻す。
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
  // 開いたときの表示(同じまま Enter を押しても決めない)
  const [opened, setOpened] = useState('')
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
        const now = formatTimecode(time, fps)
        setDraft(now)
        setOpened(now)
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
        const t = timecodeEntryValue(draft ?? opened, opened, fps, min, max)
        if (t === null) {
          setInvalid(true)
          return
        }
        if (t !== 'unchanged') onCommit(t)
        setDraft(null)
        e.currentTarget.blur()
      }}
    />
  )
}

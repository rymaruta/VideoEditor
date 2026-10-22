import { useEffect, useState, type ReactElement } from 'react'
import type { LlmLoadFailure } from '@shared/llm'

/**
 * このPCの AI のモデルを読み込めなかった(読み込み中に解析のプロセスが落ちた)ことがあれば、
 * 次からはそのモデルを試さない。ここでそれを知らせ、「もう一度試す」で記録を消して試し直せるようにする
 * (GPU を足した・メモリを増やした・ドライバを入れ直した後など)。
 * `refreshKey` が変わるたびに(自動編集が終わったときなど)読み直す。
 */
export function LocalAiRetry({ refreshKey }: { refreshKey: unknown }): ReactElement | null {
  const [failures, setFailures] = useState<LlmLoadFailure[]>([])
  useEffect(() => {
    let alive = true
    const api = window.api as Partial<typeof window.api> | undefined
    if (typeof api?.llmLoadFailures !== 'function') return
    api
      .llmLoadFailures()
      .then((list) => alive && setFailures(Array.isArray(list) ? list : []))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [refreshKey])
  if (failures.length === 0) return null
  const labels = [...new Set(failures.map((f) => f.label))].join('・')
  return (
    <span className="hint-text" title="次からは試さず、簡易の判定で続けています">
      このPCでは AI({labels})を読み込めなかったため使っていません
      <button
        className="small-button"
        onClick={() => {
          void window.api
            .llmClearLoadFailures()
            .then(() => setFailures([]))
            .catch(() => {})
        }}
      >
        このPCの AI をもう一度試す
      </button>
    </span>
  )
}

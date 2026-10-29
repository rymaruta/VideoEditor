import { useEffect, useState, type ReactElement } from 'react'
import type { LlmLoadFailure } from '@shared/llm'
import { boundaryMissedModels, retryLocalAi } from '../lib/roughCutPlan'

/**
 * このPCの AI のモデルを読み込めなかった(読み込み中に解析のプロセスが落ちた)ことがあれば、
 * 次からはそのモデルを試さない。ここでそれを知らせ、「もう一度試す」で記録を消して試し直せるようにする
 * (GPU を足した・メモリを増やした・ドライバを入れ直した後など)。
 * `refreshKey` が変わるたびに(自動編集が終わったときなど)読み直す。
 */
export function LocalAiRetry({ refreshKey }: { refreshKey: unknown }): ReactElement | null {
  const [failures, setFailures] = useState<LlmLoadFailure[]>([])
  // 区切りの確認で例文を続けて外したモデル(次から確認を省いている。描くたびに読む。軽い)
  const [, setRetried] = useState(0)
  const missed = boundaryMissedModels()
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
  if (failures.length === 0 && missed.length === 0) return null
  const labels = [...new Set(failures.map((f) => f.label))].join('・')
  return (
    <span className="hint-text" title="次からは試さず、簡易の判定で続けています">
      {failures.length > 0
        ? `このPCでは AI(${labels})を読み込めなかったため使っていません`
        : `AI(${missed.join('・')})は区切りの確認の例文を続けて外したため、区切りの確認を省いています`}
      <button
        className="small-button"
        onClick={() => {
          void retryLocalAi()
            .then(() => {
              setFailures([])
              setRetried((n) => n + 1)
            })
            .catch(() => {})
        }}
      >
        このPCの AI をもう一度試す
      </button>
    </span>
  )
}

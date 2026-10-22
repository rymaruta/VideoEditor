import { useEffect } from 'react'
import { usePipelineStore } from '../store/pipelineStore'
import { useProjectStore } from '../store/projectStore'
import './rangeAutoEdit.css'

/**
 * 範囲を自動編集して当てた直後に、タイムラインの上に出す帯。前/後を取り消し・やり直しで見比べ、
 * 範囲の頭から再生できる。「取り消す」で当てる前に戻し、「決定」で帯を閉じる。
 * 本編が前/後のどちらでもなくなったら(別の編集をした)閉じる
 */
export function RangeReviewBar(): React.JSX.Element | null {
  const review = usePipelineStore((s) => s.rangeReview)
  const clips = useProjectStore((s) => s.project.clips)
  const showing =
    review && clips === review.afterClips
      ? 'after'
      : review && clips === review.beforeClips
        ? 'before'
        : null
  useEffect(() => {
    if (review && !showing) usePipelineStore.getState().closeRangeReview()
  }, [review, showing])
  if (!review || !showing) return null
  const store = useProjectStore.getState
  const range = showing === 'after' ? review.range : review.oldRange
  const sm = review.summary
  const playFromHead = (): void => {
    store().seekTo(Math.max(0, range.start - 1))
    store().setIsPlaying(true)
  }
  return (
    <div className="range-review-bar" role="region" aria-label="範囲の自動編集の見比べ">
      <span className="range-review-title">範囲の自動編集</span>
      <div className="range-review-toggle" role="group" aria-label="前と後を見比べる">
        <button
          className={showing === 'before' ? 'active' : ''}
          aria-pressed={showing === 'before'}
          onClick={() => showing === 'after' && store().undo()}
        >
          前
        </button>
        <button
          className={showing === 'after' ? 'active' : ''}
          aria-pressed={showing === 'after'}
          onClick={() => showing === 'before' && store().redo()}
        >
          後
        </button>
      </div>
      <span className="form-note range-review-summary">
        {sm.lengthBefore.toFixed(1)}秒 → {sm.lengthAfter.toFixed(1)}秒 · カット {sm.cutsBefore} →{' '}
        {sm.cutsAfter} · テロップ {sm.telopsBefore} → {sm.telopsAfter}
      </span>
      <button className="small-button" onClick={playFromHead}>
        範囲の頭から再生
      </button>
      <div className="dialog-footer-spacer" />
      <button
        className="small-button"
        onClick={() => {
          // 取り消すと、イン点・アウト点・ルーラーの範囲も前の範囲へ戻る(pipelineStore)
          if (showing === 'after') store().undo()
          usePipelineStore.getState().closeRangeReview()
        }}
      >
        取り消す
      </button>
      <button
        className="small-button primary-button"
        onClick={() => {
          // 前を見ている間に決定したら、後へ戻してから閉じる
          if (showing === 'before') store().redo()
          usePipelineStore.getState().closeRangeReview()
        }}
      >
        決定
      </button>
    </div>
  )
}

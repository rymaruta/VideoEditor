import { useMemo } from 'react'
import type { AutoEditLock, Project } from '@shared/types'
import { lockRangesOf } from '../lib/timelineRange'
import './rangeAutoEdit.css'

/** 錠前の印 */
export function LockGlyph(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="8" rx="1.5" fill="currentColor" />
      <path
        d="M5 7V5a3 3 0 0 1 6 0v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * 自動編集で触らない範囲(ロック)の帯。場面の帯の下に1本(青灰の斜線+錠前)。
 * 右クリックで「ロックを外す」
 */
export function AutoEditLockBand({
  project,
  pixelsPerSecond,
  width,
  onLockMenu
}: {
  project: Pick<Project, 'clips' | 'multicam' | 'autoEditLocks'>
  pixelsPerSecond: number
  width: number
  onLockMenu: (e: React.MouseEvent, lock: AutoEditLock) => void
}): React.JSX.Element {
  const ranges = useMemo(
    () => lockRangesOf(project),
    // 本編・ロックが変わったときだけ数え直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project.clips, project.multicam, project.autoEditLocks]
  )
  return (
    <div className="g3-lock-band" style={{ width }}>
      {ranges.map(({ lock, range }) => (
        <span
          key={lock.id}
          className="g3-lock"
          style={{
            left: range.start * pixelsPerSecond,
            width: Math.max(4, (range.end - range.start) * pixelsPerSecond)
          }}
          title="自動編集で触らない範囲(手で編集はできます)。右クリックでロックを外す"
          onContextMenu={(e) => onLockMenu(e, lock)}
        >
          <LockGlyph />
        </span>
      ))}
    </div>
  )
}

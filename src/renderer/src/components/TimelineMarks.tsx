import { useProjectStore } from '../store/projectStore'
import { formatKeyDisplay, isMacPlatform } from '../lib/keymap'

/**
 * 目盛りの帯に出す、イン〜アウト(I / O)とマーカー(M)。
 * イン・アウトの片方だけなら、打った側から端までを薄く出す(打った側だけ縁取る)。
 * マーカーを押すとその位置へ再生位置を移す
 */
export function TimelineMarks({
  pixelsPerSecond,
  total
}: {
  pixelsPerSecond: number
  total: number
}): React.JSX.Element | null {
  const timelineIn = useProjectStore((s) => s.timelineIn)
  const timelineOut = useProjectStore((s) => s.timelineOut)
  const markers = useProjectStore((s) => s.project.markers)
  const seekTo = useProjectStore((s) => s.seekTo)

  const hasRange = timelineIn !== null || timelineOut !== null
  const from = timelineIn ?? 0
  const to = timelineOut ?? Math.max(total, from)
  const removeKey = formatKeyDisplay('Ctrl+Alt+M', isMacPlatform())

  if (!hasRange && !markers?.length) return null
  return (
    <>
      {hasRange && to >= from && (
        <span
          className={`g3-ruler-inout ${timelineIn !== null ? 'in-edge' : ''} ${
            timelineOut !== null ? 'out-edge' : ''
          }`}
          aria-hidden="true"
          style={{ left: from * pixelsPerSecond, width: (to - from) * pixelsPerSecond }}
        />
      )}
      {markers?.map((m) => (
        <button
          key={m.id}
          type="button"
          className="g3-ruler-marker"
          style={{ left: m.time * pixelsPerSecond }}
          title={`マーカー${m.label ? ` · ${m.label}` : ''}(押すとここへ移動。消すのは ${removeKey})`}
          aria-label="マーカーへ移動"
          onMouseDown={(e) => {
            // 目盛りの帯の「押した所へ移動」より先に、マーカーのちょうどの位置へ移す
            e.stopPropagation()
            seekTo(m.time)
          }}
        />
      ))}
    </>
  )
}

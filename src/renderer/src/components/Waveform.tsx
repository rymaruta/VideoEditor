import { useEffect, useState } from 'react'

export function Waveform({
  filePath,
  start,
  end,
  width,
  height
}: {
  filePath: string
  start: number
  end: number
  width: number
  height: number
}): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Debounced: props (especially start/end) can change on every mousemove while
    // trim-dragging a clip, and firing an ffmpeg subprocess per frame would flood
    // the system. Only the value the drag settles on actually needs a fetch.
    const timer = setTimeout(() => {
      window.api
        .generateWaveform(filePath, start, end, Math.round(width), Math.round(height))
        .then((dataUrl) => {
          if (!cancelled) setUrl(dataUrl)
        })
        .catch(() => {})
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [filePath, start, end, width, height])

  if (!url) return null
  return <img className="waveform-img" src={url} alt="" draggable={false} />
}

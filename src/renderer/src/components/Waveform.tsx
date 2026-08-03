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
    window.api
      .generateWaveform(filePath, start, end, Math.round(width), Math.round(height))
      .then((dataUrl) => {
        if (!cancelled) setUrl(dataUrl)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [filePath, start, end, width, height])

  if (!url) return null
  return <img className="waveform-img" src={url} alt="" draggable={false} />
}

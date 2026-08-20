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
        .catch(() => {
          // **取れなかったら、前の絵を消す。**
          //
          // 失敗を握り潰すだけだと `url` が前の範囲のまま残り、**別の範囲の波形が
          // その場所の波形として出続ける**。利用者から見て古いとは分からないので、
          // 「音が入っている」と読めてしまう。
          // (実測: 映像5秒・音声2秒の素材——録画物ではよくある形——で、
          //  範囲 1.0〜2.0(大きい音)→ 0.0〜1.0(小さい音)へトリムすると絵は
          //  ちゃんと変わる(指紋 1135b111 → 51c1a231)。そこから音声の無い
          //  2.5〜5.0 へトリムすると `generateWaveform` は失敗するのに、
          //  画面は **51c1a231 のまま**——直前の 0.0〜1.0 の波形が残っていた)
          //
          // 消したあとは「波形なし」になる。これは**その範囲を最初から開いたとき**と
          // 同じ見え方で、実際にそこには音が無い。
          // 掴んでいる最中の見え方は変えない——`url` を消すのは**失敗したときだけ**で、
          // 待っている 150ms の間は前の絵のままにしてある(でないとトリム中に点滅する)。
          if (!cancelled) setUrl(null)
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [filePath, start, end, width, height])

  if (!url) return null
  return <img className="waveform-img" src={url} alt="" draggable={false} />
}

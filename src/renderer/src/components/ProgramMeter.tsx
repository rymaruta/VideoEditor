import { useEffect, useRef } from 'react'
import { useProjectStore } from '../store/projectStore'
import { readProgramPeaks, releaseProgramMeter } from '../lib/previewMeter'
import { getSharedAudioContext } from '../lib/previewAudio'
import {
  METER_FLOOR_DB,
  PEAK_HOLD_MS,
  meterFraction,
  meterZone,
  nextBarDb,
  nextPeakHold,
  peakHoldDisplay,
  toDbfs,
  type PeakHold
} from '../lib/meterMath'

/** 目盛りの数字(dBFS) */
const SCALE = [0, -6, -12, -24, -36, -48, -60]

/**
 * プログラムの右の縦の音量計(L/R)。いまプレビューで鳴っている音を測る(lib/previewMeter)。
 * 0〜−60 dBFS、−6 から黄・−3 から赤、ピークは 1.5 秒留める。
 * 毎フレームの値は React の state に載せず、要素の style を直接書く(プレビュー全体を
 * 毎フレーム描き直さないため。ダッキングと同じ考え)
 */
export function ProgramMeter({
  rootRef
}: {
  /** 測る要素(`<video>`・`<audio>`)を探す範囲 */
  rootRef: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const playingRef = useRef(isPlaying)
  const barRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)]
  const peakRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)]
  const labelRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    playingRef.current = isPlaying
    // 再生を始めたら測る(止まっている AudioContext を動かす。再生のボタン・キーの後なので許される)
    if (isPlaying) void getSharedAudioContext()?.resume()
  }, [isPlaying])

  useEffect(() => {
    const bars = [-Infinity, -Infinity]
    const holds: PeakHold[] = [
      { db: -Infinity, at: 0 },
      { db: -Infinity, at: 0 }
    ]
    let last = performance.now()
    let frame = 0
    let quiet = false
    // 合計が 0 dBFS を超えた時刻(赤の「クリップ」の印をしばらく出す)
    let clippedAt = -Infinity
    const tick = (): void => {
      const now = performance.now()
      const dt = now - last
      last = now
      const root = rootRef.current
      const peaks = playingRef.current && root ? readProgramPeaks(root) : null
      const input = peaks ? [toDbfs(peaks.left), toDbfs(peaks.right)] : [-Infinity, -Infinity]
      if (input[0] > 0 || input[1] > 0) clippedAt = now
      let anyLit = false
      for (let ch = 0; ch < 2; ch++) {
        bars[ch] = nextBarDb(bars[ch], input[ch], dt)
        holds[ch] = nextPeakHold(holds[ch], bars[ch], now)
        const shown = peakHoldDisplay(holds[ch], now)
        if (bars[ch] > METER_FLOOR_DB || shown > METER_FLOOR_DB) anyLit = true
        const bar = barRefs[ch].current
        // 点いていない側(上)を覆う。棒そのものは色の帯の背景で、覆いを縮めると点く
        if (bar) bar.style.height = `${(1 - meterFraction(bars[ch])) * 100}%`
        const peak = peakRefs[ch].current
        if (peak) {
          peak.style.bottom = `${meterFraction(shown) * 100}%`
          peak.style.visibility = shown > METER_FLOOR_DB ? 'visible' : 'hidden'
          peak.dataset.zone = meterZone(shown)
        }
      }
      const clipping = now - clippedAt <= PEAK_HOLD_MS
      if (clipping) anyLit = true
      if (labelRef.current) {
        // 目盛りは 0 dBFS で頭打ち。超えたら数字の代わりに赤の「クリップ」
        const top = Math.min(
          0,
          Math.max(peakHoldDisplay(holds[0], now), peakHoldDisplay(holds[1], now))
        )
        labelRef.current.textContent = clipping
          ? 'クリップ'
          : top > METER_FLOOR_DB
            ? top.toFixed(1)
            : '−∞'
        labelRef.current.dataset.zone = clipping
          ? 'over'
          : top > METER_FLOOR_DB
            ? meterZone(top)
            : 'ok'
        labelRef.current.title = clipping
          ? '合計が 0 dBFS を超えました(書き出しでは割れることがあります)'
          : 'ピーク(dBFS)'
      }
      // 止まっていて全部消えたら、測るのも描くのも休む(再生を始めたら戻る)
      quiet = !anyLit && !playingRef.current
      frame = quiet ? 0 : requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    const wake = useProjectStore.subscribe((s) => {
      if (s.isPlaying && quiet && frame === 0) {
        quiet = false
        last = performance.now()
        frame = requestAnimationFrame(tick)
      }
    })
    return () => {
      wake()
      if (frame) cancelAnimationFrame(frame)
      releaseProgramMeter()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRef])

  return (
    <div className="ve-meter" role="img" aria-label="プログラムの音量計(L/R、dBFS)">
      <span ref={labelRef} className="ve-meter-peak-label" title="ピーク(dBFS)">
        −∞
      </span>
      <div className="ve-meter-body">
        <div className="ve-meter-scale" aria-hidden="true">
          {SCALE.map((db) => (
            <span key={db} style={{ bottom: `${meterFraction(db + 1e-9) * 100}%` }}>
              {db === 0 ? '0' : `${db}`.replace('-', '−')}
            </span>
          ))}
        </div>
        {[0, 1].map((ch) => (
          <div key={ch} className="ve-meter-channel">
            <div ref={barRefs[ch]} className="ve-meter-unlit" />
            <div ref={peakRefs[ch]} className="ve-meter-hold" />
          </div>
        ))}
      </div>
      <div className="ve-meter-legend" aria-hidden="true">
        <span>L</span>
        <span>R</span>
      </div>
    </div>
  )
}

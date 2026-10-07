import { useEffect, useMemo, useRef, useState } from 'react'
import { SPEECH_LOOK_TEMPLATES, speechLook } from '@shared/telop/styles'
import { usePresetStore } from '../store/presetStore'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { drawLookThumb } from '../lib/lookThumb'
import { loadTelopFonts } from '../lib/telopFonts'

const SAMPLE = 'ここが中華街の入り口です'

/**
 * 自動で入れる発言テロップの見た目を選ぶ欄(テロップの型の「発言」+ 登録したテロップスタイル)。
 * 選び直すと、すでに入っている自動の発言テロップのうち前の見た目のままの枚も替える(取り消せる)。
 * 話者にスタイルを割り当てた発言は、そちらが優先(テロップスタイルの管理で割り当てる)。
 */
export function SpeechTelopLookSelect({
  id,
  restyleExisting = true
}: {
  id: string
  /** すでに入っている自動の発言テロップも替える(新しい回を作る画面では替える物が無い) */
  restyleExisting?: boolean
}): React.JSX.Element {
  const value = useSettingsStore((s) => s.speechTelopLook)
  const presets = usePresetStore((s) => s.captionPresets)
  const look = useMemo(() => speechLook(value, presets), [value, presets])
  const canvas = useRef<HTMLCanvasElement>(null)
  const [fontEpoch, setFontEpoch] = useState(0)

  useEffect(() => {
    let alive = true
    void loadTelopFonts([{ text: SAMPLE, style: look.style }]).then((changed) => {
      if (alive && changed) setFontEpoch((e) => e + 1)
    })
    return () => {
      alive = false
    }
  }, [look])
  useEffect(() => {
    if (canvas.current) drawLookThumb(canvas.current, SAMPLE, look.style, 0.92, 8)
  }, [look, fontEpoch])

  // 消したスタイルを指していたら、欄には既定の型を出す
  const selected =
    presets.some((p) => p.id === value) || SPEECH_LOOK_TEMPLATES.some((t) => t.id === value)
      ? value
      : SPEECH_LOOK_TEMPLATES[0].id

  function choose(next: string): void {
    const settings = useSettingsStore.getState()
    const styles = usePresetStore.getState().captionPresets
    const prev = speechLook(settings.speechTelopLook, styles)
    settings.setSpeechTelopLook(next)
    if (restyleExisting)
      useProjectStore.getState().restyleSpeechTelops(prev, speechLook(next, styles), styles)
  }

  return (
    <span className="speech-look-select">
      <select
        id={id}
        value={selected}
        onChange={(e) => choose(e.target.value)}
        title="自動で入れる発言テロップの見た目(話者にスタイルを割り当てた発言は、そちらが優先)"
      >
        <optgroup label="テロップの型">
          {SPEECH_LOOK_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </optgroup>
        {presets.length > 0 && (
          <optgroup label="登録したスタイル">
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <canvas
        ref={canvas}
        className="speech-look-thumb"
        width={320}
        height={90}
        aria-label="選んだ発言テロップの見本"
      />
    </span>
  )
}

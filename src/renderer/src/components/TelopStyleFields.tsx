import type { FontFamily, TextAnimation, TextStyle } from '@shared/types'
import { FONT_FAMILY_OPTIONS, TEXT_ANIMATION_MS } from '@shared/textStyle'
import { useSettingsStore } from '../store/settingsStore'

/**
 * テロップの見た目の欄(文字 → 字間 → 塗り → 縁 → 外側の縁 → 影 → 帯 → 登場)。
 * テロップ1本の設定と、テロップスタイルの管理の両方で同じ欄を使う
 * (片方にだけ項目が増えて、もう片方で直せない、ということが起きないように)。
 */

const ANIMATIONS: { value: TextAnimation; label: string }[] = [
  { value: 'none', label: 'なし' },
  { value: 'popIn', label: 'ポップ' },
  { value: 'fadeIn', label: 'フェード' },
  { value: 'slideInUp', label: '下から' },
  { value: 'slideInDown', label: '上から' },
  { value: 'bounce', label: '弾む' },
  { value: 'typewriter', label: '1文字ずつ' }
]

export function PropRow({
  label,
  children,
  title
}: {
  label: string
  children: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <div className="prop-row" title={title}>
      <span className="prop-label">{label}</span>
      <div className="prop-control">{children}</div>
    </div>
  )
}

export function TelopStyleFields({
  style,
  onPatch: patch,
  showKaraoke = false
}: {
  style: TextStyle
  onPatch: (patch: Partial<TextStyle>) => void
  /** 単語の時刻を持つテロップだけ、カラオケの欄を出す */
  showKaraoke?: boolean
}): React.JSX.Element {
  // 外側の縁・グラデーションは共通テロップレンダラ(長尺向けの書き出し)でだけ描ける
  const drawsTelopsOnCanvas = useSettingsStore((s) => s.exportEngine === 'segmented')
  const outer = style.extraStrokes?.[0]
  const usesCanvasOnly = Boolean(outer) || Boolean(style.gradientColor)
  return (
    <>
      <PropRow label="文字">
        <select
          aria-label="フォント"
          value={style.fontFamily}
          onChange={(e) => patch({ fontFamily: e.target.value as FontFamily })}
        >
          {FONT_FAMILY_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          aria-label="サイズ"
          className="prop-num"
          min={16}
          max={96}
          step={2}
          value={style.fontSize}
          onChange={(e) => patch({ fontSize: Number(e.target.value) })}
        />
        <span className="prop-unit">px</span>
        <button
          className={`toggle-chip ${style.bold ? 'active' : ''}`}
          aria-pressed={style.bold}
          title="太字"
          onClick={() => patch({ bold: !style.bold })}
        >
          B
        </button>
        <button
          className={`toggle-chip italic ${style.italic ? 'active' : ''}`}
          aria-pressed={style.italic}
          title="斜体"
          onClick={() => patch({ italic: !style.italic })}
        >
          I
        </button>
      </PropRow>

      <PropRow label="字間">
        <input
          type="number"
          className="prop-num"
          min={0}
          max={20}
          value={style.letterSpacing}
          onChange={(e) => patch({ letterSpacing: Number(e.target.value) })}
        />
        <span className="prop-unit">px</span>
      </PropRow>

      <PropRow label="塗り">
        <input
          type="color"
          aria-label="文字の色"
          value={style.color}
          onChange={(e) => patch({ color: e.target.value })}
        />
        <label className="checkbox-label" title="文字の色を上から下へのグラデーションにします">
          <input
            type="checkbox"
            checked={Boolean(style.gradientColor)}
            onChange={(e) => patch({ gradientColor: e.target.checked ? '#ffcc00' : undefined })}
          />
          グラデーション
        </label>
        {style.gradientColor && (
          <input
            type="color"
            aria-label="グラデーションの下の色"
            value={style.gradientColor}
            onChange={(e) => patch({ gradientColor: e.target.value })}
          />
        )}
      </PropRow>

      {showKaraoke && (
        <PropRow label="カラオケ">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={style.wordHighlight}
              onChange={(e) => patch({ wordHighlight: e.target.checked })}
            />
            話した単語を色付け
          </label>
          {style.wordHighlight && (
            <input
              type="color"
              aria-label="色付けの色"
              value={style.highlightColor}
              onChange={(e) => patch({ highlightColor: e.target.value })}
            />
          )}
        </PropRow>
      )}

      <PropRow label="縁">
        <input
          type="checkbox"
          aria-label="縁を付ける"
          checked={style.outline}
          onChange={(e) => patch({ outline: e.target.checked })}
        />
        {style.outline && (
          <>
            <input
              type="color"
              aria-label="縁の色"
              value={style.outlineColor}
              onChange={(e) => patch({ outlineColor: e.target.value })}
            />
            <input
              type="number"
              aria-label="縁の太さ"
              className="prop-num"
              min={1}
              max={8}
              value={style.outlineWidth}
              onChange={(e) => patch({ outlineWidth: Number(e.target.value) })}
            />
            <span className="prop-unit">px</span>
          </>
        )}
      </PropRow>

      <PropRow label="外側の縁" title="縁のさらに外側にもう1本縁を付けます(バラエティの二重縁)">
        <input
          type="checkbox"
          aria-label="外側の縁を付ける"
          checked={Boolean(outer)}
          onChange={(e) =>
            patch({ extraStrokes: e.target.checked ? [{ color: '#ffffff', width: 6 }] : undefined })
          }
        />
        {outer && (
          <>
            <input
              type="color"
              aria-label="外側の縁の色"
              value={outer.color}
              onChange={(e) => patch({ extraStrokes: [{ ...outer, color: e.target.value }] })}
            />
            <input
              type="number"
              aria-label="外側の縁の太さ"
              className="prop-num"
              min={1}
              max={20}
              value={outer.width}
              onChange={(e) =>
                patch({ extraStrokes: [{ ...outer, width: Number(e.target.value) }] })
              }
            />
            <span className="prop-unit">px</span>
          </>
        )}
      </PropRow>
      {!drawsTelopsOnCanvas && usesCanvasOnly && (
        <p className="hint-text prop-note">
          外側の縁・グラデーションは、書き出し方式が「長尺向け」のときに表示・書き出しされます。
        </p>
      )}

      <PropRow label="影">
        <input
          type="checkbox"
          aria-label="影を付ける"
          checked={style.shadow}
          onChange={(e) => patch({ shadow: e.target.checked })}
        />
      </PropRow>

      <PropRow label="帯(座布団)">
        <input
          type="checkbox"
          aria-label="帯を敷く"
          checked={style.background}
          onChange={(e) => patch({ background: e.target.checked })}
        />
        {style.background && (
          <>
            <input
              type="color"
              aria-label="帯の色"
              value={style.backgroundColor}
              onChange={(e) => patch({ backgroundColor: e.target.value })}
            />
            <input
              type="range"
              aria-label="帯の濃さ"
              min={0}
              max={1}
              step={0.05}
              value={style.backgroundOpacity}
              onChange={(e) => patch({ backgroundOpacity: Number(e.target.value) })}
            />
            <span className="prop-unit">{Math.round(style.backgroundOpacity * 100)}%</span>
          </>
        )}
      </PropRow>

      <PropRow label="登場">
        <select
          value={style.animation}
          onChange={(e) => patch({ animation: e.target.value as TextAnimation })}
        >
          {ANIMATIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        {TEXT_ANIMATION_MS[style.animation] > 0 && (
          <span className="prop-unit">
            {(TEXT_ANIMATION_MS[style.animation] / 1000).toFixed(2)} 秒
          </span>
        )}
      </PropRow>
    </>
  )
}

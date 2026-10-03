import type { MediaAsset } from '@shared/types'
import { colorMatchFilterId } from '../lib/colorMatchCss'

/**
 * カメラ間の色合わせを、プレビューの `<video>` に掛けるための SVG フィルタ。
 * 書き出しの lutrgb と同じ式(出力 = 入力 × gain + offset)を、チャンネルごとの一次式で掛ける。
 * 計算は sRGB のまま(既定の linearRGB だと書き出しと色が変わる)。
 */
export function ColorMatchFilters({ assets }: { assets: MediaAsset[] }): React.JSX.Element | null {
  const matched = assets.filter((a) => a.colorMatch)
  if (matched.length === 0) return null
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        {matched.map((a) => {
          const m = a.colorMatch!
          return (
            <filter key={a.id} id={colorMatchFilterId(a.id)} colorInterpolationFilters="sRGB">
              <feComponentTransfer>
                <feFuncR type="linear" slope={m.gain[0]} intercept={m.offset[0]} />
                <feFuncG type="linear" slope={m.gain[1]} intercept={m.offset[1]} />
                <feFuncB type="linear" slope={m.gain[2]} intercept={m.offset[2]} />
              </feComponentTransfer>
            </filter>
          )
        })}
      </defs>
    </svg>
  )
}

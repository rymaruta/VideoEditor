import { describe, expect, it } from 'vitest'
import { PIP_RING_PX, pipPreviewStyle } from '@renderer/lib/pipPreviewStyle'
import { PIP_MARGIN_RATIO, pipMarginPx } from '@shared/pipLayout'
import type { PipPosition } from '@shared/types'
import { NASTY_NUMBERS, seeded } from '../helpers/boundary'

const CORNERS: PipPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
/** ワイプの大きさのつまみ(`Timeline.tsx`)の範囲 */
const SCALE_MIN = 0.15
const SCALE_MAX = 0.5

/**
 * 書き出し側の規則(`ffmpegService.ts`)。
 * - 絵の幅  = 出力幅 x track.scale (`scale=${w * track.scale}:-2`)
 * - 隅の余白 = `pipMarginPx(出力幅)` (`overlay=x=W-w-${margin}`)
 * どちらも**出力幅に対する比**なので、画面でも同じ比になっていなければならない。
 */
function exportPictureRatio(scale: number): number {
  return scale
}

/** 画面の指定から「絵そのもの」の幅の比を出す。`border` を使うとここが縮む。 */
function previewPictureRatio(style: Record<string, unknown>): number {
  const w = String(style.width)
  expect(w.endsWith('%'), `width=${w}`).toBe(true)
  const boxRatio = parseFloat(w) / 100
  // `box-sizing: border-box` なので、`border` を書くとそのぶん絵が縮む。
  // ここでは「指定に border が無いこと」を比の計算に織り込んでいる。
  const border = style.border ?? style.borderWidth ?? style.borderLeftWidth
  return border === undefined ? boxRatio : NaN
}

describe('【レグレッション】画面のワイプが、書き出しと同じ大きさ・同じ隅の距離で描かれる (2026-09-14)', () => {
  /**
   * 白い縁取りを `border` で描いていたため、`box-sizing: border-box` の下で
   * **絵そのものが左右合わせて 4px 縮み**、隅からの距離は逆に 2px 広がっていた。
   * 縮む量が固定なので、**枠が小さいほど・ワイプが小さいほど割合が大きくなる**。
   *
   * 実測(素材 320x240 のワイプを右下・書き出した画の画素と突き合わせ。
   * 書き出しはどの条件でも幅 0.30000 / 余白 0.04063):
   *
   * | 企画 / つまみ | 修正前の絵の割合 | 修正前の余白 | 修正後の絵の割合 | 修正後の余白 |
   * |---|---|---|---|---|
   * | 16:9 / 0.50 | 0.49046 (-1.91%) | 0.04473 | 0.49998 | 0.03997 |
   * | 16:9 / 0.30 | 0.29048 (-3.17%) | 0.04473 | 0.30000 | 0.03997 |
   * | 16:9 / 0.15 | 0.14046 (-6.36%) | 0.04473 | 0.14998 | 0.03997 |
   * | 9:16 / 0.30 | 0.26992 (**-10.03%**) | 0.05499 | 0.30000 | 0.03995 |
   * | 9:16 / 0.15 | 0.11986 (**-20.09%**) | 0.05499 | 0.14994 | 0.03995 |
   */
  it('絵の幅は書き出しと同じ比(飾りが食い込まない)', () => {
    for (const scale of [SCALE_MIN, 0.3, SCALE_MAX]) {
      const style = pipPreviewStyle('bottom-right', scale, 420.266) as Record<string, unknown>
      expect(previewPictureRatio(style), `つまみ${scale}`).toBe(exportPictureRatio(scale))
    }
  })

  it('レイアウトに参加する飾りを持たない(border も padding も margin も無い)', () => {
    for (const corner of CORNERS) {
      const style = pipPreviewStyle(corner, 0.3, 420) as Record<string, unknown>
      for (const key of [
        'border',
        'borderWidth',
        'borderLeftWidth',
        'borderTopWidth',
        'padding',
        'paddingLeft',
        'margin',
        'outlineOffset'
      ]) {
        expect(style[key], `${corner}.${key}`).toBe(undefined)
      }
    }
  })

  it('白い輪と落ち影は残っている(飾りを消したのではなく、外へ出した)', () => {
    const style = pipPreviewStyle('bottom-right', 0.3, 420)
    expect(style.boxShadow).toContain(`0 0 0 ${PIP_RING_PX}px rgba(255, 255, 255, 0.8)`)
    expect(style.boxShadow).toContain('0 4px 16px rgba(0, 0, 0, 0.5)')
  })

  it('隅からの距離は共有の置き場から出す(幅基準の px)', () => {
    for (const frameWidth of [133.0, 420.266, 640, 1920]) {
      const margin = pipMarginPx(frameWidth)
      expect(margin).toBeCloseTo(frameWidth * PIP_MARGIN_RATIO, 9)
      expect(pipPreviewStyle('top-left', 0.3, frameWidth)).toMatchObject({
        top: margin,
        left: margin
      })
      expect(pipPreviewStyle('bottom-right', 0.3, frameWidth)).toMatchObject({
        bottom: margin,
        right: margin
      })
    }
  })

  it('四隅とも、指定するのは自分の側の2辺だけ', () => {
    const sides = (s: Record<string, unknown>): string[] =>
      (['top', 'right', 'bottom', 'left'] as const).filter((k) => s[k] !== undefined)
    expect(sides(pipPreviewStyle('top-left', 0.3, 400) as never).sort()).toEqual(['left', 'top'])
    expect(sides(pipPreviewStyle('top-right', 0.3, 400) as never).sort()).toEqual(['right', 'top'])
    expect(sides(pipPreviewStyle('bottom-left', 0.3, 400) as never).sort()).toEqual([
      'bottom',
      'left'
    ])
    expect(sides(pipPreviewStyle('bottom-right', 0.3, 400) as never).sort()).toEqual([
      'bottom',
      'right'
    ])
  })

  it('境界: 枠が 0・負・NaN・Infinity でも余白は有限(共有の関門が吸収する)', () => {
    for (const w of NASTY_NUMBERS) {
      for (const corner of CORNERS) {
        const style = pipPreviewStyle(corner, 0.3, w) as Record<string, unknown>
        for (const k of ['top', 'right', 'bottom', 'left'] as const) {
          if (style[k] === undefined) continue
          expect(Number.isFinite(style[k] as number), `枠${w} ${corner}.${k}`).toBe(true)
          expect(style[k] as number).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  it('【不変条件】つまみの全域で、画面の絵の比と書き出しの比が完全に一致する', () => {
    const rnd = seeded(20260914)
    const widths = [133.0, 200, 420.266, 640, 1080, 1920]
    for (let i = 0; i < 5000; i++) {
      const scale = SCALE_MIN + rnd() * (SCALE_MAX - SCALE_MIN)
      const frameWidth = widths[Math.floor(rnd() * widths.length)]
      const style = pipPreviewStyle(CORNERS[i % 4], scale, frameWidth) as Record<string, unknown>
      // `${scale * 100}%` を読み戻すので、任意の小数では往復の誤差が 1e-16 ほど残る
      // (つまみが実際に作るのは 0.01 刻みの値だけで、そちらは上の検査で完全一致を見ている)。
      // 直したのは 4px ぶんの縮み——枠 133px なら 0.03 に相当するので、
      // 12桁で見れば取り違えようがない。
      expect(previewPictureRatio(style), `つまみ${scale} 枠${frameWidth}`).toBeCloseTo(
        exportPictureRatio(scale),
        12
      )
      // 絵が枠に収まる(余白 x2 を足しても 1 を超えない)
      const marginRatio = pipMarginPx(frameWidth) / frameWidth
      expect(scale + marginRatio).toBeLessThanOrEqual(1)
    }
  })

  it('対照: `border` で描いた昔の形なら、この検査は落ちる', () => {
    // 「絵の比を測れている」ことの裏取り。修正前の指定を手で組んで通す。
    const old = { width: '30%', border: '2px solid rgba(255, 255, 255, 0.8)' }
    expect(Number.isNaN(previewPictureRatio(old))).toBe(true)
    // 縮む量は「枠に対する 4px」。9:16 の枠(実測 132.97px)・つまみ 0.15 で
    // **実測 0.11986** まで落ちていた。式で置くと 0.15 - 4/132.97 = 0.11992。
    const frame = 132.97
    expect(0.15 - (2 * PIP_RING_PX) / frame).toBeCloseTo(0.11986, 3)
    // 16:9 の枠(実測 420.266px)では同じ 4px が 0.29048(実測)にしか効かない
    expect(0.3 - (2 * PIP_RING_PX) / 420.266).toBeCloseTo(0.29048, 4)
    // 修正後は 0.15 ちょうど
    expect(previewPictureRatio(pipPreviewStyle('bottom-right', 0.15, frame) as never)).toBe(0.15)
    expect(previewPictureRatio(pipPreviewStyle('bottom-right', 0.3, 420.266) as never)).toBe(0.3)
  })
})

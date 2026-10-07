import { describe, expect, it } from 'vitest'
import {
  detectHud,
  HUD_OVERLAP_LIMIT,
  hudCoverage,
  speechYAvoidingHud
} from '../../src/shared/telop/hud'

const W = 160
const H = 90

/** 動く絵(時刻ごとに違う模様)に、動かない HUD(下の帯の白黒の縞)を重ねた画 */
function frame(t: number, hud: boolean): Uint8Array {
  const out = new Uint8Array(W * H * 3)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      let v = (Math.sin(x * 0.21 + t * 1.7) * Math.cos(y * 0.17 - t * 2.3) * 0.5 + 0.5) * 255
      // 下の 82〜92% の帯の真ん中に、縞(文字・枠のような輪郭)を置く
      if (hud && y >= 0.82 * H && y < 0.92 * H && x >= 0.3 * W && x < 0.7 * W)
        v = x % 4 < 2 ? 255 : 0
      out[i] = out[i + 1] = out[i + 2] = v
    }
  return out
}

describe('ゲーム画面の動かない表示(HUD)', () => {
  it('動かない輪郭のある所だけを HUD にし、動く絵は HUD にしない', () => {
    const map = detectHud(
      [0, 1, 2, 3, 4, 5].map((t) => frame(t, true)),
      W,
      H
    )!
    // 縞の半分の画素が輪郭(白と黒の境目)
    expect(hudCoverage(map, { x0: 0.3, x1: 0.7, y0: 0.82, y1: 0.92 })).toBeGreaterThan(0.15)
    expect(hudCoverage(map, { x0: 0, x1: 1, y0: 0, y1: 0.7 })).toBeLessThan(0.02)
    const none = detectHud(
      [0, 1, 2, 3, 4, 5].map((t) => frame(t, false)),
      W,
      H
    )!
    expect(hudCoverage(none, { x0: 0, x1: 1, y0: 0, y1: 1 })).toBeLessThan(0.02)
    expect(detectHud([frame(0, true)], W, H)).toBeNull()
  })

  it('下の中央の帯が HUD に掛かれば、掛からない高さへ上げる。掛からなければ動かさない', () => {
    const map = detectHud(
      [0, 1, 2, 3, 4, 5].map((t) => frame(t, true)),
      W,
      H
    )!
    const y = speechYAvoidingHud(map, 0.88)!
    expect(y).toBeLessThan(0.8)
    expect(y).toBeGreaterThan(0.6)
    // 上げた先の帯は、HUD にほとんど掛からない
    expect(hudCoverage(map, { x0: 0.2, x1: 0.8, y0: y - 0.08, y1: y + 0.08 })).toBeLessThanOrEqual(
      HUD_OVERLAP_LIMIT
    )
    const none = detectHud(
      [0, 1, 2, 3, 4, 5].map((t) => frame(t, false)),
      W,
      H
    )!
    expect(speechYAvoidingHud(none, 0.88)).toBeNull()
  })
})

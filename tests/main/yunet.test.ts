import { describe, expect, it } from 'vitest'
import { decodeYunet } from '@main/yunet'

/** ストライド 8 の格子だけに候補を置いた出力を作る */
function outputs(
  cands: { row: number; col: number; score: number; dw?: number }[]
): Record<string, { data: Float32Array }> {
  const n8 = 80 * 80
  const cls = new Float32Array(n8)
  const obj = new Float32Array(n8)
  const bbox = new Float32Array(n8 * 4)
  for (const c of cands) {
    const i = c.row * 80 + c.col
    cls[i] = c.score
    obj[i] = c.score
    bbox[i * 4 + 2] = c.dw ?? Math.log(4) // 幅 32px
    bbox[i * 4 + 3] = Math.log(4)
  }
  const empty = (n: number): { data: Float32Array } => ({ data: new Float32Array(n) })
  return {
    cls_8: { data: cls },
    obj_8: { data: obj },
    bbox_8: { data: bbox },
    cls_16: empty(1600),
    obj_16: empty(1600),
    bbox_16: empty(6400),
    cls_32: empty(400),
    obj_32: empty(400),
    bbox_32: empty(1600)
  }
}

describe('decodeYunet', () => {
  it('格子の位置と大きさから枠を作り、点数の低いものは捨てる', () => {
    const boxes = decodeYunet(
      outputs([
        { row: 10, col: 20, score: 0.9 },
        { row: 50, col: 50, score: 0.3 }
      ])
    )
    expect(boxes).toHaveLength(1)
    expect(boxes[0].x).toBeCloseTo(20 * 8 - 16, 6)
    expect(boxes[0].y).toBeCloseTo(10 * 8 - 16, 6)
    expect(boxes[0].w).toBeCloseTo(32, 6)
    expect(boxes[0].score).toBeCloseTo(0.9, 6)
  })

  it('重なった候補は、点数の高い方だけ残す', () => {
    const boxes = decodeYunet(
      outputs([
        { row: 10, col: 20, score: 0.9 },
        { row: 10, col: 21, score: 0.8 }
      ])
    )
    expect(boxes).toHaveLength(1)
    expect(boxes[0].score).toBeCloseTo(0.9, 6)
  })
})

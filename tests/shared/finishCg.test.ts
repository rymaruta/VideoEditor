import { describe, expect, it } from 'vitest'
import { CG_MAX_SECONDS, planCg } from '../../src/shared/finish/cg'

const cg = {
  うまい: [
    { path: '/cg/umai1.mov', name: 'umai1.mov', duration: 3 },
    { path: '/cg/umai2.mov', name: 'umai2.mov', duration: 3 }
  ],
  'うまい!': [{ path: '/cg/umai_big.mov', name: 'umai_big.mov', duration: 20 }],
  え: [{ path: '/cg/e.mov', name: 'e.mov', duration: 2 }]
}

describe('planCg', () => {
  it('きっかけの言葉を含むテロップの出だしに置く。長い言葉を先に見て、同じ言葉は順番に使う', () => {
    const r = planCg(
      [
        { text: 'これうまい', startTime: 2 },
        { text: 'うまい!最高', startTime: 10 },
        { text: 'ほんとにうまい', startTime: 30 }
      ],
      cg
    )
    expect(r.map((x) => [x.startTime, x.path, x.outPoint])).toEqual([
      [2, '/cg/umai1.mov', 3],
      // 長い素材は 8 秒で切る
      [10, '/cg/umai_big.mov', CG_MAX_SECONDS],
      [30, '/cg/umai2.mov', 3]
    ])
  })

  it('CG どうしは重ねない。1文字の言葉は使わない', () => {
    const r = planCg(
      [
        { text: 'うまい', startTime: 0 },
        { text: 'うまい', startTime: 1 },
        { text: 'え?', startTime: 5 }
      ],
      cg
    )
    expect(r.map((x) => x.startTime)).toEqual([0])
  })
})

import { describe, expect, it } from 'vitest'
import { solvePlacements } from '../../src/shared/sync/solve'
import { buildMulticamLayout } from '../../src/shared/sync/multicamLayout'
import { tidyTelopText } from '../../src/shared/telop/fromTranscript'
import { fileNamePrefix } from '../../src/shared/ingest/classify'
import { balancedLineEnds, breakScore } from '../../src/shared/telop/polish'
import { planCg } from '../../src/shared/finish/cg'
import { buildScenes, type TimedLine } from '../../src/shared/structure/scenes'
import { applyCutOverrides } from '../../src/shared/roughCut/overrides'

describe('取り込み〜仮編集の境目', () => {
  it('カメラ1台・1本だけの回も、基準の素材として並べる', () => {
    const report = solvePlacements([{ id: 'a', sourceId: 'A', duration: 100 }], [])
    expect(report.placements[0].method).not.toBe('none')
    expect(report.issues).toEqual([])
    const layout = buildMulticamLayout(
      [{ id: 'A', name: 'カメラA', kind: 'camera' }],
      [{ id: 'a', sourceId: 'A', duration: 100 }],
      report.placements
    )
    expect(layout?.main).toHaveLength(1)
  })

  it('同じマイクの続くファイルが大きく重なっても、二重に鳴らさない', () => {
    const layout = buildMulticamLayout(
      [
        { id: 'C', name: 'カメラ', kind: 'camera' },
        { id: 'M', name: 'マイク', kind: 'mic' }
      ],
      [
        { id: 'c', sourceId: 'C', duration: 1000 },
        { id: 'm1', sourceId: 'M', duration: 500 },
        { id: 'm2', sourceId: 'M', duration: 500 }
      ],
      [
        { id: 'c', start: 0, method: 'audio', rate: 1 },
        { id: 'm1', start: 0, method: 'audio', rate: 1 },
        { id: 'm2', start: 499.7, method: 'audio', rate: 1 }
      ]
    )!
    const pieces = layout.mics[0].pieces
    for (let i = 1; i < pieces.length; i++) {
      const prev = pieces[i - 1]
      const prevEnd = prev.startTime + (prev.outPoint - prev.inPoint) / prev.speed
      expect(pieces[i].startTime).toBeGreaterThanOrEqual(prevEnd - 1e-9)
    }
  })

  it('テロップの文で、数字の桁区切りのカンマは残す', () => {
    expect(tidyTelopText('このうに丼は2,800円です。')).toBe('このうに丼は2,800円です')
    expect(tidyTelopText('えっと、すごい,ね')).toBe('えっと すごい ね')
  })

  it('濁点を分けた形・全角数字のファイル名でも、同じ機材の名前になる', () => {
    expect(fileNamePrefix('ビデオ_0001.mp4'.normalize('NFD'))).toBe(
      fileNamePrefix('ビデオ_0002.mp4')
    )
    expect(fileNamePrefix('カメラ１.mp4')).toBe(fileNamePrefix('カメラ2.mp4'))
  })

  it('絵文字の組み合わせの途中では改行しない', () => {
    for (let k = 1; k < 30; k++) {
      const chars = [...('あ'.repeat(k) + '👨‍👩‍👧' + 'い'.repeat(30 - k))]
      for (const end of balancedLineEnds(chars, 14)) {
        if (end > 0 && end < chars.length) {
          expect(chars[end]).not.toBe('‍')
          expect(chars[end - 1]).not.toBe('‍')
        }
      }
    }
    expect(breakScore([...'がき'], 1)).toBe(-Infinity)
  })

  it('版面CG の言葉は、全角/半角・装飾の印の違いを無視して当てる', () => {
    const cg = { 'うまい!': [{ path: '/cg/umai.png', name: 'umai.png', duration: 0, still: true }] }
    expect(planCg([{ text: 'これうまい！', startTime: 1 }], cg)).toHaveLength(1)
    expect(planCg([{ text: '**うま**い!', startTime: 1 }], cg)).toHaveLength(1)
  })

  it('1万行の場面分け・2千区間の手直しが速い', () => {
    const lines: TimedLine[] = Array.from({ length: 10000 }, (_, i) => ({
      id: `l${i}`,
      start: i * 1.08,
      end: i * 1.08 + 0.9,
      text: 'あ',
      overlap: false
    }))
    let t = performance.now()
    buildScenes(lines, { start: 0, end: 10800 })
    expect(performance.now() - t).toBeLessThan(400)
    const pieces = Array.from({ length: 2000 }, (_, i) => ({
      start: i * 5,
      end: i * 5 + 4,
      sceneId: 's'
    }))
    const removed = Array.from({ length: 2000 }, (_, i) => ({ start: i * 5 + 1, end: i * 5 + 2 }))
    t = performance.now()
    const kept = applyCutOverrides(pieces, { removed, added: [], angles: [] })
    expect(performance.now() - t).toBeLessThan(300)
    expect(kept).toHaveLength(4000)
  })
})

import { describe, expect, it } from 'vitest'
import { buildRunReport, formatElapsed } from '@renderer/lib/runReport'

describe('formatElapsed', () => {
  it('秒・分・時間で読みやすく', () => {
    expect(formatElapsed(4_400)).toBe('4秒')
    expect(formatElapsed(133_000)).toBe('2分13秒')
    expect(formatElapsed(3_900_000)).toBe('1時間05分')
  })
})

describe('buildRunReport', () => {
  it('工程ごとの時間・合計・収録の長さに対する割合・PC の構成を書く', () => {
    const text = buildRunReport({
      episode: '#297',
      steps: [
        { id: 'sync', label: '同期', status: { state: 'done', percent: 100, elapsedMs: 60_000 } },
        {
          id: 'transcribe',
          label: '文字起こし',
          status: { state: 'done', percent: 100, elapsedMs: 540_000, note: '120 件' }
        },
        { id: 'effects', label: '演出テロップ', status: { state: 'skipped', percent: 0 } }
      ],
      footage: { cameras: 3, mics: 4, totalSec: 7 * 3600, longestSec: 3600 },
      system: {
        os: 'Windows_NT 10.0',
        cpu: 'Ryzen 9',
        cores: 32,
        memoryGb: 64,
        gpu: ['RTX 5090'],
        app: 'VideoEditor 1.0.0'
      },
      log: [{ time: 0, text: '同期を始めます' }],
      now: new Date(0)
    })
    expect(text).toContain('文字起こし\t完了\t9分00秒\t120 件')
    expect(text).toContain('合計\t\t10分00秒')
    // 10分 / 収録1時間 = 17%
    expect(text).toContain('収録の長さに対する処理時間: 17%')
    expect(text).toContain('GPU: RTX 5090')
    expect(text).toContain('同期を始めます')
  })
})

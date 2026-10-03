import { describe, expect, it } from 'vitest'
import { defaultTextStyle } from '../../src/shared/textStyle'
import {
  DEFAULT_SHOW_STYLE,
  describeShowStyle,
  learnShowStyle,
  measureProject,
  normalizeShowStyle
} from '../../src/shared/style/showStyle'
import type { Project } from '../../src/shared/types'

const style = defaultTextStyle()

/** ショットの長さ・発言の間・SE・BGM・周りの音を持つ、人が仕上げた回の模型 */
function episode(shot: number, gap: number, seCount: number, bgmVolume: number): Project {
  const clips = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`,
    assetId: 'cam',
    inPoint: i * shot,
    outPoint: (i + 1) * shot,
    speed: 1
  }))
  const total = 20 * shot
  const textOverlays = Array.from({ length: 30 }, (_, i) => ({
    id: `t${i}`,
    text: `発言${i}`,
    startTime: i * (2 + gap),
    endTime: i * (2 + gap) + 2,
    style
  }))
  return {
    id: 'p',
    name: 'ep',
    aspectRatio: '16:9',
    assets: [],
    clips,
    videoOverlayTracks: [],
    textOverlays,
    audioTracks: [
      {
        id: 'amb',
        name: '周りの音',
        multicamSourceId: 'camA',
        muted: false,
        volume: 0.4,
        duckingEnabled: false,
        clips: []
      },
      {
        id: 'mic',
        name: '出演者A',
        multicamSourceId: 'mic1',
        voice: true,
        muted: false,
        volume: 1,
        duckingEnabled: false,
        clips: []
      },
      {
        id: 'se',
        name: '効果音',
        muted: false,
        volume: 1,
        duckingEnabled: false,
        clips: Array.from({ length: seCount }, (_, i) => ({
          id: `s${i}`,
          assetId: 'se',
          startTime: (i * total) / seCount,
          inPoint: 0,
          outPoint: 0.8
        }))
      },
      {
        id: 'bgm',
        name: 'BGM',
        muted: false,
        volume: 1,
        duckingEnabled: true,
        clips: [
          { id: 'b', assetId: 'bgm', startTime: 0, inPoint: 0, outPoint: total, volume: bgmVolume }
        ]
      }
    ]
  }
}

describe('measureProject', () => {
  it('ショットの長さ・発言の間・1分あたりの SE・BGM と周りの音の音量を測る', () => {
    // 1ショット 4秒 × 20 = 80秒、間 0.5秒、SE 8個 → 1分に 6個
    const m = measureProject(episode(4, 0.5, 8, 0.25))
    expect(m.minShotSec).toBeCloseTo(4)
    expect(m.maxShotSec).toBeCloseTo(4)
    expect(m.keepPauseSec).toBeCloseTo(0.5)
    expect(m.sePerMinute).toBeCloseTo(6)
    expect(m.bgmVolume).toBeCloseTo(0.25)
    expect(m.ambienceVolume).toBeCloseTo(0.4)
  })

  it('測れない項目は返さない(本編1本・発言が少ない・SE が1つも無い)', () => {
    const p = { ...episode(4, 0.5, 0, 0.3), clips: [], textOverlays: [] }
    const m = measureProject(p)
    expect(m.minShotSec).toBeUndefined()
    expect(m.keepPauseSec).toBeUndefined()
    expect(measureProject(episode(4, 0.5, 0, 0.3)).sePerMinute).toBeUndefined()
  })
})

describe('learnShowStyle', () => {
  it('本どうしは中央値でまとめ、1本だけ特殊な回に引っぱられない', () => {
    const r = learnShowStyle([
      episode(3, 0.4, 8, 0.2),
      episode(4, 0.5, 8, 0.25),
      episode(30, 3, 100, 0.9)
    ])
    expect(r.projects).toBe(3)
    expect(r.style.minShotSec).toBe(4)
    expect(r.style.bgmVolume).toBe(0.25)
    expect(r.learned.minShotSec).toBe(3)
  })

  it('範囲の外は収め、最短 < 最長・残す間 < 詰める間 を保つ', () => {
    const r = learnShowStyle([episode(0.2, 0.05, 0, 0.01)])
    expect(r.style.minShotSec).toBeGreaterThanOrEqual(0.8)
    expect(r.style.maxShotSec).toBeGreaterThan(r.style.minShotSec)
    expect(r.style.keepPauseSec).toBeLessThan(r.style.maxPauseSec)
    expect(r.style.bgmVolume).toBeGreaterThanOrEqual(0.05)
  })

  it('何も無ければ既定値のまま', () => {
    expect(learnShowStyle([]).style).toEqual(DEFAULT_SHOW_STYLE)
  })
})

describe('normalizeShowStyle', () => {
  it('壊れた値は既定値、範囲外は収める', () => {
    const s = normalizeShowStyle({ minShotSec: 'x', maxShotSec: 999, bgmVolume: 0.5 })
    expect(s.minShotSec).toBe(DEFAULT_SHOW_STYLE.minShotSec)
    expect(s.maxShotSec).toBe(20)
    expect(s.bgmVolume).toBe(0.5)
    expect(describeShowStyle(s)).toContain('BGM 50%')
  })
})

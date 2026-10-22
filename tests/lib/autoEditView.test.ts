import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import type { Scene } from '@shared/structure/scenes'
import {
  commonSpan,
  eventRanges,
  formatDuration,
  frameSourceAt,
  keptOrder,
  mergeRanges,
  overallFraction,
  sceneChips,
  sceneTitle,
  sourceLanes,
  speakerCount,
  speakerLanes,
  speechRatio
} from '@renderer/lib/autoEditView'

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [
      {
        id: 'cam',
        filePath: '/a/cam.mov',
        fileName: 'cam.mov',
        duration: 100,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      },
      {
        id: 'mic',
        filePath: '/a/mic.wav',
        fileName: 'mic.wav',
        duration: 100,
        width: 0,
        height: 0,
        fps: 0,
        hasAudio: true,
        hasVideo: false
      }
    ],
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    multicam: {
      anchorSourceId: 'A',
      sources: [
        { id: 'A', name: 'カメラA', kind: 'camera' },
        { id: 'M', name: 'マイク', kind: 'mic' }
      ],
      files: [
        { assetId: 'cam', sourceId: 'A', start: 0, rate: 1, duration: 60 },
        { assetId: 'mic', sourceId: 'M', start: 10, rate: 1, duration: 80 }
      ]
    },
    ...over
  }) as unknown as Project

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1',
  start: 0,
  end: 20,
  lines: [{ id: 'l', speaker: 'トム', start: 1, end: 3, text: 'こんにちは', overlap: false }],
  speech: 12,
  ...over
})

describe('formatDuration', () => {
  it('m:ss、1 時間を超えたら h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(242.04)).toBe('4:02')
    expect(formatDuration(3725)).toBe('1:02:05')
    expect(formatDuration(-3)).toBe('0:00')
  })
})

describe('overallFraction', () => {
  it('済み・省略は 1、進行中は割合、待ちは 0', () => {
    expect(
      overallFraction([
        { state: 'done', percent: 100 },
        { state: 'skipped', percent: 0 },
        { state: 'run', percent: 50 },
        { state: 'wait', percent: 0 }
      ])
    ).toBeCloseTo(2.5 / 4)
    expect(overallFraction([])).toBe(0)
    expect(overallFraction([{ state: 'run', percent: 250 }])).toBe(1)
  })
})

describe('mergeRanges', () => {
  it('重なり・近い区間をまとめ、長さの無い区間は捨てる', () => {
    expect(
      mergeRanges(
        [
          { start: 5, end: 8 },
          { start: 0, end: 2 },
          { start: 7, end: 9 },
          { start: 3, end: 3 }
        ],
        0
      )
    ).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 9 }
    ])
    expect(
      mergeRanges(
        [
          { start: 0, end: 2 },
          { start: 2.5, end: 3 }
        ],
        1
      )
    ).toEqual([{ start: 0, end: 3 }])
  })
})

describe('同期の情報から', () => {
  it('全体の長さ・機材ごとの区間', () => {
    const p = project()
    expect(commonSpan(p)).toBe(90)
    expect(sourceLanes(p)).toEqual([
      { id: 'A', name: 'カメラA', ranges: [{ start: 0, end: 60 }] },
      { id: 'M', name: 'マイク', ranges: [{ start: 10, end: 90 }] }
    ])
    expect(commonSpan(project({ multicam: undefined }))).toBe(0)
    expect(sourceLanes(project({ multicam: undefined }))).toEqual([])
  })
  it('話者ごとの区間(素材の時刻を共通の時刻へ)。話者の無い・長さの無い発話は外す', () => {
    const p = project({
      transcript: [
        {
          id: 'u1',
          assetId: 'mic',
          speaker: 'トム',
          sourceStart: 0,
          sourceEnd: 2,
          text: 'a',
          words: [],
          overlap: false
        },
        {
          id: 'u2',
          assetId: 'mic',
          sourceStart: 3,
          sourceEnd: 4,
          text: 'b',
          words: [],
          overlap: false
        },
        {
          id: 'u3',
          assetId: 'mic',
          speaker: 'ゼロ',
          sourceStart: 5,
          sourceEnd: 5,
          text: 'c',
          words: [],
          overlap: false
        }
      ]
    } as Partial<Project>)
    expect(speakerLanes(p)).toEqual([{ speaker: 'トム', ranges: [{ start: 10, end: 12 }] }])
  })
  it('場面の絵はその時刻を録っているカメラから(カメラが無い時刻は null)', () => {
    const p = project()
    expect(frameSourceAt(p, 30)).toEqual({ filePath: '/a/cam.mov', at: 30 })
    expect(frameSourceAt(p, 70)).toBeNull()
  })
})

describe('eventRanges', () => {
  it('しきい値を超えた笑い・歓声の区間だけ', () => {
    const p = project({
      audioEvents: [
        { start: 0, end: 1, laugh: 0.5, cheer: 0 },
        { start: 1, end: 2, laugh: 0.5, cheer: 0.9 },
        { start: 5, end: 6, laugh: 0, cheer: 0 }
      ]
    } as Partial<Project>)
    expect(eventRanges(p)).toEqual({
      laugh: [{ start: 0, end: 2 }],
      cheer: [{ start: 1, end: 2 }]
    })
  })
})

describe('場面の表示', () => {
  it('話している割合・話者の数・見出し', () => {
    expect(speechRatio(scene())).toBeCloseTo(0.6)
    expect(speechRatio(scene({ start: 5, end: 5 }))).toBe(0)
    expect(speakerCount(scene())).toBe(1)
    expect(sceneTitle(scene(), undefined)).toBe('トム「こんにちは」')
    expect(sceneTitle(scene({ lines: [] }), undefined)).toBe('(会話なし)')
    expect(
      sceneTitle(scene(), {
        sceneId: 's1',
        score: 80,
        kind: 'highlight',
        title: '再会',
        reason: ''
      })
    ).toBe('再会')
  })
  it('理由の印はデータのあるものだけ(測っていない笑い・歓声は出さない)', () => {
    expect(sceneChips(scene(), undefined, null, undefined)).toEqual([
      { label: '発話 60%', tone: 'ok' }
    ])
    const chips = sceneChips(
      scene({ laughs: 2, cheers: 0, hype: 1, speech: 4 }),
      { sceneId: 's1', score: 90, kind: 'highlight', reason: '' },
      'ai',
      true
    )
    expect(chips.map((c) => c.label)).toEqual([
      '笑い 2',
      '盛り上がり 1',
      '発話 20%',
      'AI · 見どころ',
      '手で残す'
    ])
    expect(chips.find((c) => c.label === '手で残す')?.manual).toBe(true)
  })
  it('帯の色の順は、残す場面だけで数える', () => {
    const order = keptOrder([{ id: 'a' }, { id: 'b' }, { id: 'c' }], (id) => id !== 'b')
    expect([...order.entries()]).toEqual([
      ['a', 0],
      ['b', null],
      ['c', 1]
    ])
  })
})

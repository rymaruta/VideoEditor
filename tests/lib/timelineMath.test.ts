import { describe, expect, it } from 'vitest'
import {
  audioClipDuration,
  buildTimedClips,
  findFreeAudioStart,
  toSourceSeconds,
  toTimelineSeconds,
  totalExportDuration,
  totalTimelineDuration
} from '@renderer/lib/timelineMath'
import type { Project } from '@shared/types'
import { NASTY_NUMBERS, round, seeded } from '../helpers/boundary'

const project = (over: Partial<Project> = {}): Project =>
  ({
    id: 'p',
    name: 't',
    aspectRatio: '16:9',
    assets: [
      {
        id: 'A',
        filePath: '/x/a.mp4',
        fileName: 'a.mp4',
        duration: 30,
        width: 1280,
        height: 720,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      }
    ],
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    beatGrid: null,
    ...over
  }) as unknown as Project

const clip = (id: string, inP: number, outP: number, extra: object = {}): object => ({
  id,
  assetId: 'A',
  inPoint: inP,
  outPoint: outP,
  speed: 1,
  ...extra
})

describe('toSourceSeconds / toTimelineSeconds — 速度をまたぐ換算', () => {
  it('等速なら同じ', () => {
    expect(toSourceSeconds(3, 1)).toBe(3)
    expect(toTimelineSeconds(3, 1)).toBe(3)
  })

  it('2倍速はタイムライン1秒＝素材2秒', () => {
    expect(toSourceSeconds(1, 2)).toBe(2)
    expect(toTimelineSeconds(2, 2)).toBe(1)
  })

  it('往復して元に戻る', () => {
    const rnd = seeded(555)
    for (let i = 0; i < 5000; i++) {
      const t = rnd() * 100
      const speed = 0.25 + rnd() * 3.75
      expect(round(toTimelineSeconds(toSourceSeconds(t, speed), speed), 6)).toBe(round(t, 6))
    }
  })

  it('速度が未設定・0・負・NaN でも壊れない(1倍として扱う)', () => {
    for (const bad of [undefined, 0, -1, NaN, Infinity]) {
      const r = toSourceSeconds(3, bad as number)
      expect(Number.isFinite(r), String(bad)).toBe(true)
    }
  })
})

describe('audioClipDuration — 音声クリップのタイムライン上の長さ', () => {
  it('速度で割る', () => {
    expect(audioClipDuration({ inPoint: 0, outPoint: 4, speed: 1 })).toBe(4)
    expect(audioClipDuration({ inPoint: 0, outPoint: 4, speed: 2 })).toBe(2)
    expect(audioClipDuration({ inPoint: 1, outPoint: 4, speed: 0.5 })).toBe(6)
  })

  it('速度が未設定なら等速', () => {
    expect(audioClipDuration({ inPoint: 0, outPoint: 4 })).toBe(4)
  })

  it('速度 0 を渡しても Infinity を返さない', () => {
    const d = audioClipDuration({ inPoint: 0, outPoint: 4, speed: 0 })
    expect(Number.isFinite(d)).toBe(true)
  })
})

describe('totalTimelineDuration / totalExportDuration', () => {
  const clips = [
    clip('a', 0, 5),
    clip('b', 0, 5, { transitionIn: { type: 'crossfade', duration: 1 } })
  ]

  it('画面の総尺は単純な足し算', () => {
    const timed = buildTimedClips(project({ clips } as Partial<Project>))
    expect(totalTimelineDuration(timed)).toBe(10)
  })

  it('書き出しの総尺はつなぎの重なりを引く', () => {
    const timed = buildTimedClips(project({ clips } as Partial<Project>))
    expect(totalExportDuration(timed)).toBe(9)
  })

  it('つなぎが無ければ両者は一致する', () => {
    const timed = buildTimedClips(
      project({ clips: [clip('a', 0, 5), clip('b', 0, 5)] } as Partial<Project>)
    )
    expect(totalExportDuration(timed)).toBe(totalTimelineDuration(timed))
  })

  it('クリップ0本なら両方 0', () => {
    const timed = buildTimedClips(project())
    expect(totalTimelineDuration(timed)).toBe(0)
    expect(totalExportDuration(timed)).toBe(0)
  })

  it('【不変条件】書き出しの総尺 <= 画面の総尺、どちらも 0 以上の有限', () => {
    const rnd = seeded(24680)
    for (let i = 0; i < 2000; i++) {
      const n = Math.floor(rnd() * 6)
      const cs = Array.from({ length: n }, (_, k) =>
        clip(
          'c' + k,
          0,
          0.2 + rnd() * 8,
          k > 0 && rnd() < 0.6 ? { transitionIn: { type: 'crossfade', duration: rnd() * 3 } } : {}
        )
      )
      const timed = buildTimedClips(project({ clips: cs } as Partial<Project>))
      const t = totalTimelineDuration(timed)
      const e = totalExportDuration(timed)
      expect(Number.isFinite(t) && Number.isFinite(e), `n=${n}`).toBe(true)
      expect(t).toBeGreaterThanOrEqual(0)
      expect(e).toBeGreaterThanOrEqual(0)
      expect(e).toBeLessThanOrEqual(t + 1e-9)
    }
  })
})

describe('buildTimedClips — 素材の無いクリップは捨てる', () => {
  it('居ない素材を指すクリップは並びに入らない', () => {
    const timed = buildTimedClips(
      project({
        clips: [clip('a', 0, 5), { ...clip('b', 0, 5), assetId: 'MISSING' }]
      } as Partial<Project>)
    )
    expect(timed).toHaveLength(1)
    expect(timed[0].clip.id).toBe('a')
  })

  it('並びは前から積み上がる', () => {
    const timed = buildTimedClips(
      project({ clips: [clip('a', 0, 4), clip('b', 0, 3), clip('c', 0, 2)] } as Partial<Project>)
    )
    expect(timed.map((t) => t.start)).toEqual([0, 4, 7])
    expect(timed.map((t) => t.end)).toEqual([4, 7, 9])
  })
})

describe('findFreeAudioStart — 重ならない置き場所', () => {
  const existing = [
    { startTime: 0, inPoint: 0, outPoint: 3, speed: 1 },
    { startTime: 5, inPoint: 0, outPoint: 2, speed: 1 }
  ]

  it('空いていればそのまま', () => {
    expect(findFreeAudioStart(existing, 3, 2)).toBe(3)
  })

  it('ぶつかったら直後へ逃がす', () => {
    expect(findFreeAudioStart(existing, 1, 2)).toBe(3)
  })

  it('逃げた先でもぶつかるなら、さらに後ろへ', () => {
    expect(findFreeAudioStart(existing, 1, 4)).toBe(7)
  })

  it('何も無ければ希望どおり', () => {
    expect(findFreeAudioStart([], 4, 2)).toBe(4)
  })

  it('負・NaN の希望位置は 0 から探す', () => {
    expect(findFreeAudioStart([], -5, 2)).toBe(0)
    expect(findFreeAudioStart([], NaN, 2)).toBe(0)
  })

  it('尺が 0・負・NaN なら希望位置をそのまま返す(探しようがない)', () => {
    for (const d of [0, -1, NaN]) {
      const r = findFreeAudioStart(existing, 1, d)
      expect(Number.isFinite(r), String(d)).toBe(true)
      expect(r).toBeGreaterThanOrEqual(0)
    }
  })

  it('【不変条件】返した位置に置くと、既存のどれとも重ならない', () => {
    const rnd = seeded(112233)
    for (let i = 0; i < 3000; i++) {
      const n = Math.floor(rnd() * 6)
      const clips = Array.from({ length: n }, () => {
        const s = rnd() * 30
        return { startTime: s, inPoint: 0, outPoint: 0.2 + rnd() * 5, speed: 1 }
      })
      const dur = 0.2 + rnd() * 4
      const start = findFreeAudioStart(clips, rnd() * 30, dur)
      expect(Number.isFinite(start)).toBe(true)
      expect(start).toBeGreaterThanOrEqual(0)
      for (const c of clips) {
        const cs = c.startTime
        const ce = c.startTime + audioClipDuration(c)
        const overlap = start < ce - 1e-9 && cs < start + dur - 1e-9
        expect(overlap, `start=${start} dur=${dur} vs ${cs}..${ce}`).toBe(false)
      }
    }
  })

  it('異常な既存クリップが混ざっていても落ちない', () => {
    for (const bad of NASTY_NUMBERS) {
      const r = findFreeAudioStart([{ startTime: bad, inPoint: 0, outPoint: bad, speed: 1 }], 1, 2)
      expect(Number.isNaN(r), `${bad} -> ${r}`).toBe(false)
    }
  })
})

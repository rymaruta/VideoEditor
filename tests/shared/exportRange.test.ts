import { describe, expect, it } from 'vitest'
import {
  planSegments,
  segmentsInRange,
  snapExportRange,
  type SegmentPlanOptions
} from '@shared/sequence/segmentPlan'
import { timelineRangeToExportFrames } from '@shared/sequence/fromV1'
import { estimateOutputBytes, estimateSegmentedExportBytes } from '@shared/exportDiskSpace'
import type { MediaItem, Sequence } from '@shared/sequence/types'
import type { MediaAsset, Project } from '@shared/types'
import { NASTY_NUMBERS, seeded } from '../helpers/boundary'

/**
 * 範囲だけの書き出し(第3段の書き出しの画面の「選んだ範囲」)と、形式ごとの大きさの見込み。
 * 範囲は全体の区間の並びから切り出す。境は繋ぎを割らない位置へ広げる(区間の境と同じ決まり)
 */

const media = (
  id: string,
  startFrame: number,
  durationFrames: number,
  transition = 0
): MediaItem => ({
  kind: 'media',
  id,
  assetId: 'a',
  startFrame,
  durationFrames,
  sourceIn: 0,
  speed: 1,
  origin: 'manual',
  placement: { kind: 'frame', fit: 'contain' },
  ...(transition > 0 ? { transitionIn: { type: 'crossfade', durationFrames: transition } } : {})
})

const seq = (items: MediaItem[]): Sequence => ({
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  videoTracks: [{ id: 'v0', name: 'V0', hidden: false, items }],
  audioTracks: []
})

const OPT: SegmentPlanOptions = { targetFrames: 100, minFrames: 50, maxFrames: 200 }

describe('snapExportRange — 範囲の境を繋ぎの外へ', () => {
  it('ふつう: 繋ぎに掛からない境はそのまま', () => {
    const s = seq([media('a', 0, 300), media('b', 300, 300)])
    expect(snapExportRange(s, 90, 450)).toEqual({ startFrame: 90, endFrame: 450 })
  })

  it('始まりが繋ぎ(300〜330)の中なら、繋ぎの手前へ。終わりが繋ぎの中なら、繋ぎの次へ', () => {
    // b は 300 から 30 フレームの繋ぎで入る
    const s = seq([media('a', 0, 330), media('b', 300, 300, 30)])
    expect(snapExportRange(s, 310, 500)).toEqual({ startFrame: 299, endFrame: 500 })
    expect(snapExportRange(s, 100, 300)).toEqual({ startFrame: 100, endFrame: 331 })
    expect(snapExportRange(s, 100, 330)).toEqual({ startFrame: 100, endFrame: 331 })
  })

  it('尺の外は尺に収め、逆向きは並べ直す。空・数でない範囲は null', () => {
    const s = seq([media('a', 0, 300)])
    expect(snapExportRange(s, 400, -50)).toEqual({ startFrame: 0, endFrame: 300 })
    expect(snapExportRange(s, 120, 120)).toBeNull()
    expect(snapExportRange(s, Number.NaN, 100)).toBeNull()
    expect(snapExportRange(s, 0, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('境界値: どんな数でも、返す範囲は尺の中で始まり < 終わり', () => {
    const s = seq([media('a', 0, 330), media('b', 300, 300, 30)])
    for (const a of NASTY_NUMBERS)
      for (const b of NASTY_NUMBERS) {
        const r = snapExportRange(s, a, b)
        if (!r) continue
        expect(r.startFrame).toBeGreaterThanOrEqual(0)
        expect(r.endFrame).toBeLessThanOrEqual(600)
        expect(r.endFrame).toBeGreaterThan(r.startFrame)
      }
  })
})

describe('segmentsInRange — 全体の区間から範囲を切り出す', () => {
  it('範囲に掛かる区間だけを、範囲の境で切り、番号を 0 から振り直す', () => {
    const s = seq([media('a', 0, 1000)])
    const all = planSegments(s, OPT)
    const part = segmentsInRange(all, 150, 420)
    expect(part[0].index).toBe(0)
    expect(part[0].startFrame).toBe(150)
    expect(part[part.length - 1].endFrame).toBe(420)
    // 隙間も重なりも無く続く
    for (let i = 1; i < part.length; i++) expect(part[i].startFrame).toBe(part[i - 1].endFrame)
  })

  it('不変条件: 乱数の範囲でも、切り出した区間の長さの合計は範囲の長さと同じ', () => {
    const rnd = seeded(31)
    const s = seq([media('a', 0, 400), media('b', 370, 500, 30), media('c', 870, 600)])
    const all = planSegments(s, OPT)
    for (let k = 0; k < 500; k++) {
      const a = Math.floor(rnd() * 1470)
      const b = Math.floor(rnd() * 1470)
      const r = snapExportRange(s, a, b)
      if (!r) continue
      const part = segmentsInRange(all, r.startFrame, r.endFrame)
      const total = part.reduce((n, x) => n + (x.endFrame - x.startFrame), 0)
      expect(total).toBe(r.endFrame - r.startFrame)
      expect(part.every((x) => x.endFrame > x.startFrame)).toBe(true)
    }
  })
})

describe('timelineRangeToExportFrames — タイムラインの秒 → 書き出しのフレーム', () => {
  const asset: MediaAsset = {
    id: 'A',
    filePath: '/m/a.mp4',
    fileName: 'a.mp4',
    duration: 60,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    hasVideo: true
  }
  const project = (clips: Project['clips']): Pick<Project, 'clips' | 'assets'> => ({
    assets: [asset],
    clips
  })

  it('繋ぎが無ければ秒 × fps。書き出しの中の始まりの秒も返す', () => {
    const p = project([{ id: 'c', assetId: 'A', inPoint: 0, outPoint: 10, speed: 1 }])
    expect(timelineRangeToExportFrames(p, 2, 6.5)).toEqual({
      startFrame: 60,
      endFrame: 195,
      startSec: 2
    })
  })

  it('繋ぎ(1 秒)の後ろの範囲は、書き出しでは 1 秒手前になる', () => {
    const p = project([
      { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1 },
      {
        id: 'c2',
        assetId: 'A',
        inPoint: 10,
        outPoint: 14,
        speed: 1,
        transitionIn: { type: 'crossfade', duration: 1 }
      } as Project['clips'][number]
    ])
    const r = timelineRangeToExportFrames(p, 5, 7)
    expect(r?.startFrame).toBe(120)
    expect(r?.endFrame).toBe(180)
  })

  it('本編の外・空・数でない範囲は null(尺で頭打ち)', () => {
    const p = project([{ id: 'c', assetId: 'A', inPoint: 0, outPoint: 10, speed: 1 }])
    expect(timelineRangeToExportFrames(p, 20, 30)).toBeNull()
    expect(timelineRangeToExportFrames(p, 3, 3)).toBeNull()
    expect(timelineRangeToExportFrames(p, Number.NaN, 3)).toBeNull()
    expect(timelineRangeToExportFrames(p, 8, 30)?.endFrame).toBe(300)
  })
})

describe('書き出しの大きさの見込み(形式ごと)', () => {
  const base = { durationSec: 300, width: 1920, height: 1080, fps: 29.97, quality: 'high' as const }

  it('WAV は形式で決まる: 48kHz・24bit・ステレオで 1 秒 288,000 バイト(映像は数えない)', () => {
    expect(estimateOutputBytes({ ...base, format: 'wav' })).toBe(300 * 288_000)
    expect(estimateSegmentedExportBytes({ ...base, format: 'wav' }).output).toBe(300 * 288_000)
  })

  it('ProRes 422 は Apple の公表値(1080p30 で約 147Mbps)に近く、H.264 の高画質より何倍も大きい', () => {
    const prores = estimateOutputBytes({ ...base, format: 'prores' })
    const mbps = (prores * 8) / 300 / 1e6
    expect(mbps).toBeGreaterThan(140)
    expect(mbps).toBeLessThan(155)
    expect(prores).toBeGreaterThan(estimateOutputBytes({ ...base, format: 'mp4' }) * 10)
  })

  it('MP4 は画質の段の順に小さくなる。止めるための見込み(少なめ)は画面の目安より小さい', () => {
    const high = estimateOutputBytes({ ...base, format: 'mp4' })
    const std = estimateOutputBytes({ ...base, quality: 'standard', format: 'mp4' })
    const small = estimateOutputBytes({ ...base, quality: 'small', format: 'mp4' })
    expect(high).toBeGreaterThan(std)
    expect(std).toBeGreaterThan(small)
    expect(estimateSegmentedExportBytes(base).output).toBeLessThan(high)
  })

  it('境界値: 長さが 0・負・数でなければ 0(映像も音も数えない)', () => {
    for (const d of [0, -5, Number.NaN, Number.NEGATIVE_INFINITY])
      for (const format of ['mp4', 'prores', 'wav'] as const)
        expect(estimateOutputBytes({ ...base, durationSec: d, format })).toBe(0)
  })
})

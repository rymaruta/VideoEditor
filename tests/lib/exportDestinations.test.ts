import { describe, expect, it } from 'vitest'
import {
  DESTINATIONS,
  destinationSettings,
  jobFileName,
  matchDestination,
  sourceAspect,
  sourceHeight,
  type DestinationSettings,
  type ExportJob
} from '../../src/renderer/src/lib/exportDestinations'
import {
  mergePieceLevels,
  pieceColumns,
  timelineAudioPieces
} from '../../src/renderer/src/lib/timelineWave'
import type { Project } from '@shared/types'

/**
 * 書き出しの画面の行き先(今ある書き出しの設定を並べ替えるだけ)と、キューのファイル名、小さな波形の切れ。
 */

const base: DestinationSettings = {
  aspectRatio: '16:9',
  resolutionHeight: 720,
  quality: 'standard',
  loudness: 'off',
  format: 'mp4',
  xml: false
}

describe('行き先', () => {
  it('どの行き先も、選んだ後の設定はその行き先に当たる(往復)', () => {
    for (const d of DESTINATIONS) {
      const next = destinationSettings(d.id, base, 1080, '16:9')
      expect(matchDestination(next, 1080, '16:9')).toBe(d.id)
    }
  })

  it('YouTube は 16:9・1080・高画質・−14 LUFS の MP4。ショートは縦', () => {
    expect(destinationSettings('youtube', base, 720, '16:9')).toEqual({
      aspectRatio: '16:9',
      resolutionHeight: 1080,
      quality: 'high',
      loudness: 'web',
      format: 'mp4',
      xml: false
    })
    expect(destinationSettings('short', base, 720, '16:9').aspectRatio).toBe('9:16')
  })

  it('音声のみ・XML は形式・XML だけを変え、ほかの設定は今のまま', () => {
    expect(destinationSettings('audio', base, 1080, '16:9')).toEqual({ ...base, format: 'wav' })
    expect(destinationSettings('xml', base, 1080, '16:9')).toEqual({ ...base, xml: true })
  })

  it('手で変えた組み合わせは、どの行き先でもない', () => {
    expect(matchDestination(base, 1080, '16:9')).toBeNull()
    expect(
      matchDestination({ ...base, format: 'prores', resolutionHeight: 720 }, 1080, '16:9')
    ).toBeNull()
  })

  it('元の解像度: 素材が縮まずに収まる一番小さい段(1280×534 は 720、1920×1080 は 1080、縦の素材も短い辺で)', () => {
    const a = (width: number, height: number): { width: number; height: number } => ({
      width,
      height
    })
    expect(sourceHeight([a(1280, 534)])).toBe(720)
    expect(sourceHeight([a(1920, 1080)])).toBe(1080)
    expect(sourceHeight([a(1080, 1920)])).toBe(1080)
    expect(sourceHeight([a(3840, 2160), a(1280, 720)])).toBe(2160)
    expect(sourceHeight([a(8000, 4000)])).toBe(2160)
    expect(sourceHeight([])).toBe(1080)
    // 静止画・音だけの素材は数えない
    expect(sourceHeight([{ width: 4000, height: 3000, still: true }, a(1280, 720)])).toBe(720)
    expect(sourceAspect([a(1080, 1920)], '16:9')).toBe('9:16')
    expect(sourceAspect([], '9:16')).toBe('9:16')
  })
})

describe('jobFileName — キューのファイル名', () => {
  const job: ExportJob = {
    aspectRatio: '16:9',
    resolutionHeight: 1080,
    quality: 'high',
    format: 'mp4'
  }

  it('形式の拡張子で終わり、見えている違いはすべて名前に入る(同じ名前で上書きしない)', () => {
    const names = [
      jobFileName('第12回', job),
      jobFileName('第12回', { ...job, quality: 'small' }),
      jobFileName('第12回', { ...job, aspectRatio: '9:16' }),
      jobFileName('第12回', { ...job, resolutionHeight: 720 }),
      jobFileName('第12回', { ...job, format: 'prores' }),
      jobFileName('第12回', { ...job, format: 'wav' }),
      jobFileName('第12回', { ...job, range: { start: 110, end: 140 } }),
      jobFileName('第12回', { ...job, range: { start: 3725, end: 3800 } })
    ]
    expect(new Set(names).size).toBe(names.length)
    expect(names[0]).toBe('第12回_16x9_1080p_高画質.mp4')
    expect(names[4].endsWith('.mov')).toBe(true)
    expect(names[5]).toBe('第12回_音声.wav')
    expect(names[6]).toBe('第12回_16x9_1080p_高画質_0h01m50s-0h02m20s.mp4')
  })

  it('ファイル名に使えない字は潰す', () => {
    expect(jobFileName('a/b:c', job)).not.toMatch(/[/:]/)
  })
})

describe('小さな波形の切れ(timelineWave)', () => {
  const project = {
    assets: [
      { id: 'v', filePath: '/m/v.mp4', hasAudio: true, hasVideo: true, width: 1, height: 1 },
      { id: 'm', filePath: '/m/m.wav', hasAudio: true, hasVideo: false, width: 0, height: 0 },
      { id: 's', filePath: '/m/s.png', hasAudio: false, hasVideo: true, width: 1, height: 1 }
    ],
    clips: [
      { id: 'c1', assetId: 'v', inPoint: 10, outPoint: 20, speed: 1 },
      { id: 'c2', assetId: 's', inPoint: 0, outPoint: 5, speed: 1 },
      { id: 'c3', assetId: 'v', inPoint: 30, outPoint: 40, speed: 2, audioDetached: true }
    ],
    audioTracks: [
      {
        id: 't',
        muted: false,
        clips: [{ id: 'a', assetId: 'm', startTime: 2, inPoint: 0, outPoint: 6, speed: 2 }]
      },
      {
        id: 'mute',
        muted: true,
        clips: [{ id: 'b', assetId: 'm', startTime: 0, inPoint: 0, outPoint: 9 }]
      }
    ]
  } as unknown as Project

  it('本編の音・ミュートしていない音声トラックの、区間に掛かる所だけ(音の無い素材・分けた音・ミュートは除く)', () => {
    const pieces = timelineAudioPieces(project, 5, 12)
    expect(pieces).toEqual([
      { filePath: '/m/v.mp4', tlStart: 5, tlEnd: 10, srcStart: 15, srcEnd: 20 }
      // 速さ 2 の音声: タイムライン 2〜5 → 5 から先は無い。区間に掛かるのは無い
    ])
    const later = timelineAudioPieces(project, 0, 4)
    expect(later).toContainEqual({
      filePath: '/m/m.wav',
      tlStart: 2,
      tlEnd: 4,
      srcStart: 0,
      srcEnd: 4
    })
  })

  it('切れの列を区間の列へ並べ、重なりは大きい方。区間が空なら全部 0', () => {
    const piece = { filePath: 'x', tlStart: 0, tlEnd: 5, srcStart: 0, srcEnd: 5 }
    const piece2 = { filePath: 'y', tlStart: 0, tlEnd: 10, srcStart: 0, srcEnd: 10 }
    const out = mergePieceLevels(
      [
        { piece, levels: [1, 1] },
        { piece: piece2, levels: [0.5, 0.5, 0.5, 0.5] }
      ],
      0,
      10,
      4
    )
    expect(Array.from(out)).toEqual([1, 1, 0.5, 0.5])
    expect(Array.from(mergePieceLevels([{ piece, levels: [1] }], 3, 3, 4))).toEqual([0, 0, 0, 0])
    expect(pieceColumns(piece, 0, 10, 100)).toBe(50)
    expect(pieceColumns(piece, 0, 0, 100)).toBe(1)
  })
})

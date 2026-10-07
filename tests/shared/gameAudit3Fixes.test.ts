import { describe, expect, it } from 'vitest'
import { craigSessionEdges, solvePlacements } from '@shared/sync/solve'
import { sameVoice, TURN_RATE } from '@shared/diarize/micTurns'
import { standardExportFits } from '@shared/exportLimits'
import { buildRoughCut } from '@shared/roughCut/build'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Project } from '@shared/types'

/** ゲーム実況の3回目の全体監査で見つけた不具合の再発防止 */

describe('Craig の話者別ファイルは頭がそろっている', () => {
  it('あまり話さない人のファイルも、同じフォルダの Craig のファイルと同じ所に置く', () => {
    const files = [
      { id: '/r/obs.mkv', sourceId: 'cam', duration: 600, camera: true },
      { id: '/r/craig/1-taro.flac', sourceId: 'craig:1', duration: 590 },
      { id: '/r/craig/2-hana.flac', sourceId: 'craig:2', duration: 590 }
    ]
    const edges = craigSessionEdges(
      files.map((f) => ({
        id: f.id,
        path: f.id,
        duration: f.duration,
        isCraig: f.id.includes('craig')
      }))
    )
    expect(edges).toEqual([
      { a: '/r/craig/1-taro.flac', b: '/r/craig/2-hana.flac', offset: 0, confidence: 1, rate: 1 }
    ])
    // よく話す人だけが OBS と音で合い、あまり話さない人は音では決まらない
    const audio = [{ a: '/r/obs.mkv', b: '/r/craig/1-taro.flac', offset: 12.34, confidence: 80 }]
    const sol = solvePlacements(files, [...audio, ...edges])
    const at = new Map(sol.placements.map((p) => [p.id, p]))
    expect(at.get('/r/craig/2-hana.flac')?.method).not.toBe('none')
    expect(at.get('/r/craig/2-hana.flac')!.start).toBeCloseTo(
      at.get('/r/craig/1-taro.flac')!.start,
      6
    )
    // 音で決まった組があれば、そちらが勝つ(Craig の組はどの音の組より弱い)
    const both = solvePlacements(files, [
      ...audio,
      { a: '/r/obs.mkv', b: '/r/craig/2-hana.flac', offset: 12.34, confidence: 40 },
      ...edges
    ])
    expect(both.issues.filter((i) => i.kind === 'conflict')).toHaveLength(0)
    // 長さのそろわない「1-名前.wav」の録音機(別々に録り始めたもの)はつながない
    expect(
      craigSessionEdges([
        { id: 'a', path: '/r/rec/1-taro.wav', isCraig: true, duration: 1800 },
        { id: 'b', path: '/r/rec/2-hana.wav', isCraig: true, duration: 1234 }
      ])
    ).toEqual([])
  })
})

describe('同じ声を拾った2本のマイク', () => {
  const env = (on: (t: number) => boolean, gain: number): Float32Array =>
    Float32Array.from({ length: 120 * TURN_RATE }, (_, i) =>
      on(i / TURN_RATE) ? 0.3 * gain : 0.002 * gain
    )
  const streamer = (t: number): boolean => Math.floor(t / 3) % 3 === 0
  const friend = (t: number): boolean => Math.floor(t / 3) % 3 === 1
  it('同じ人(音量だけ違う)なら同じ声、別の人なら違う', () => {
    expect(
      sameVoice(
        { id: 'obs', envelope: env(streamer, 1) },
        { id: 'craig', envelope: env(streamer, 0.4) }
      )
    ).toBe(true)
    expect(
      sameVoice({ id: 'obs', envelope: env(streamer, 1) }, { id: 'f', envelope: env(friend, 1) })
    ).toBe(false)
  })
})

describe('標準の書き出しがコマンドラインに収まるか', () => {
  const project = (pieces: number, pathLen: number): Project =>
    ({
      assets: [{ id: 'A', filePath: 'C:\\\\' + 'x'.repeat(pathLen) }],
      clips: Array.from({ length: pieces }, (_, i) => ({
        id: `c${i}`,
        assetId: 'A',
        inPoint: i,
        outPoint: i + 1,
        speed: 1
      })),
      videoOverlayTracks: [],
      audioTracks: Array.from({ length: 8 }, (_, k) => ({
        id: `t${k}`,
        muted: k === 7,
        clips: Array.from({ length: pieces }, (_, i) => ({ id: `a${k}${i}`, assetId: 'A' }))
      }))
    }) as unknown as Project
  it('Windows で区間の多い企画は収まらない(区間ごとの書き出しへ)。少なければ収まる', () => {
    expect(standardExportFits(project(60, 100), 'win32').fits).toBe(false)
    expect(standardExportFits(project(3, 100), 'win32').fits).toBe(true)
    // 消音のトラックは数えない
    expect(standardExportFits(project(3, 100), 'win32').inputs).toBe(3 * 2 + 3 * 7)
    // 一度に開く入力が多すぎれば、どの OS でも収まらない
    expect(standardExportFits(project(60, 10), 'linux').fits).toBe(false)
    expect(standardExportFits(project(20, 10), 'linux').fits).toBe(true)
  })
})

describe('ゲーム画面の録画が無く、顔カメラだけの回', () => {
  it('基準の顔カメラを本編に使い、ワイプにはしない', () => {
    const info: MulticamInfo = {
      anchorSourceId: 'f1',
      sources: [
        { id: 'f1', name: '顔', kind: 'camera', cameraRole: 'face' },
        { id: 'f2', name: '顔2', kind: 'camera', cameraRole: 'face' }
      ],
      files: [
        { assetId: 'F1', sourceId: 'f1', start: 0, rate: 1, duration: 60 },
        { assetId: 'F2', sourceId: 'f2', start: 0, rate: 1, duration: 60 }
      ]
    }
    const cut = buildRoughCut([{ start: 0, end: 30, cameraId: 'f1' }] as never, info)
    expect(cut.main.length).toBeGreaterThan(0)
    expect((cut.overlays ?? []).map((o) => o.sourceId)).toEqual(['f2'])
  })
})

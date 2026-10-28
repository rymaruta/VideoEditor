import { describe, expect, it } from 'vitest'
import { applyVerticalFill } from '@renderer/lib/verticalFraming'
import { computeMainTrackLayout } from '@shared/mainTrackLayout'
import { projectFrameRate } from '@shared/frameRate'
import type { FaceBox } from '@shared/telop/avoidFaces'
import type { Project } from '@shared/types'

/**
 * 再監査の指摘 1: 話す人の切り替えで分けた所の素材の位置を、書き出しと同じ関数(`computeMainTrackLayout`)の
 * コマの番号で求める。式を写して丸めていたので、ちょうど半コマの時刻で1コマずれた(25fps・前のクリップ
 * 2.7 秒で 40ms、50fps・2.71 秒で 20ms の音飛び)。前のクリップの長さを 10ms 刻みで 12,600 通り × 5 つの
 * フレームレートで計算し、分けた所で素材の位置が1サンプル(1/48000 秒)もずれないことを確かめる。
 * 1b: 速さを変えたクリップは分けない(上下に積む)
 */
const face = (x: number): FaceBox => ({ x, y: 0.3, w: 0.08, h: 0.128, score: 0.9 })
const speakers = {
  faces: new Map([
    [
      'A',
      new Map([
        ['甲', 0.19],
        ['乙', 0.79]
      ])
    ]
  ])
}
const faces = new Map(
  ['c0', 'c1'].map((id) => [id, [{ time: 1, faces: [face(0.15), face(0.75)] }]])
)

function project(fps: number, first: number, speed = 1): Project {
  return {
    id: 'p',
    name: 'p',
    aspectRatio: '9:16',
    assets: [
      {
        id: 'A',
        filePath: '/a.mp4',
        fileName: 'a.mp4',
        duration: 400,
        width: 640,
        height: 360,
        fps,
        hasAudio: true,
        hasVideo: true
      }
    ],
    clips: [
      { id: 'c0', assetId: 'A', inPoint: 0, outPoint: first, speed: 1 },
      { id: 'c1', assetId: 'A', inPoint: first, outPoint: first + 12 * speed, speed }
    ],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: []
  } as unknown as Project
}

/** 分けたクリップの2本目の頭で、書き出しの読む素材の位置と、続いていればあるはずの位置の差(秒) */
function gapAt(p: Project, first: number): number | null {
  const lines = [
    { speaker: '乙', start: first, end: first + 3 },
    { speaker: '甲', start: first + 3.0167, end: first + 12 }
  ]
  const r = applyVerticalFill(p, faces, { speakers: { ...speakers, lines } }).project
  const pieces = r.clips.filter((c) => c.id.startsWith('c1'))
  if (pieces.length !== 2) return null
  const fps = projectFrameRate(r.clips, r.assets)
  const layout = computeMainTrackLayout(r.clips, fps)
  const f = (i: number): number => Math.round(layout.exportStarts[i] * fps)
  const want = pieces[0].inPoint + ((f(2) - f(1)) / fps) * (pieces[0].speed || 1)
  return Math.abs(pieces[1].inPoint - want)
}

describe('分けた所の素材の位置は、書き出しのコマにそろう', () => {
  for (const fps of [25, 30, 50, 59.94, 29.97])
    it(`${fps}fps: 前のクリップ 0.01〜126.00 秒(10ms 刻み)のどれでも、ずれは1サンプル未満`, () => {
      let worst = 0
      let at = 0
      for (let k = 1; k <= 12600; k++) {
        const first = k / 100
        const g = gapAt(project(fps, first), first)
        expect(g, `${first}`).not.toBeNull()
        if (g! > worst) {
          worst = g!
          at = first
        }
      }
      expect(worst, `最大 ${at} 秒`).toBeLessThan(1 / 48000)
    }, 120_000)

  it('監査の再現: 25fps・2.7 秒、50fps・2.71 秒', () => {
    expect(gapAt(project(25, 2.7), 2.7)!).toBeLessThan(1 / 48000)
    expect(gapAt(project(50, 2.71), 2.71)!).toBeLessThan(1 / 48000)
  })

  it('速さを変えたクリップは分けず、上下に積む', () => {
    const p = project(59.94, 2, 0.8)
    const r = applyVerticalFill(p, faces, {
      speakers: {
        ...speakers,
        lines: [
          { speaker: '乙', start: 2, end: 5 },
          { speaker: '甲', start: 5.2, end: 16 }
        ]
      }
    })
    expect(r.project.clips.filter((c) => c.id.startsWith('c1'))).toHaveLength(1)
    expect(r.project.clips[1].splitStack).toBeDefined()
    expect(r.switched).toBe(0)
  })
})

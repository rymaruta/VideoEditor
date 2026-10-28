import { describe, expect, it } from 'vitest'
import {
  applyVerticalFill,
  detectFaceFrames,
  framesOnFaces,
  MAX_FACE_FRAMES,
  planFaceFrames,
  prepareVerticalFill,
  verticalSamples,
  type FaceSample
} from '@renderer/lib/verticalFraming'
import type { FaceBox } from '@shared/telop/avoidFaces'
import { defaultTextStyle } from '@shared/textStyle'
import type { Clip, Project, TextOverlay } from '@shared/types'

/** 縦の切り出し(顔に寄せる)の監査の指摘 C1〜C7 */

const face = (x: number, y = 0.3, w = 0.08, h = 0.13): FaceBox => ({ x, y, w, h, score: 0.9 })
const asset = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  filePath: `/r/${id}.mp4`,
  fileName: `${id}.mp4`,
  duration: 3600,
  width: 1920,
  height: 1080,
  hasAudio: true,
  hasVideo: true,
  ...extra
})
const telop = (
  id: string,
  start: number,
  end: number,
  extra: Partial<TextOverlay> = {}
): TextOverlay =>
  ({
    id,
    text: '賃上げもしっかりと\nされたというふうに',
    startTime: start,
    endTime: end,
    style: defaultTextStyle(),
    source: 'auto',
    utteranceId: `u-${id}`,
    utteranceChunk: 0,
    ...extra
  }) as TextOverlay
const projectOf = (clips: Partial<Clip>[], textOverlays: TextOverlay[] = [], extra = {}): Project =>
  ({
    id: 'p',
    name: 'p',
    aspectRatio: '9:16',
    assets: [asset('A'), asset('S', { still: true }), asset('V', { width: 1080, height: 1920 })],
    clips: clips.map((c, i) => ({ id: `c${i + 1}`, assetId: 'A', speed: 1, ...c })),
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays,
    ...extra
  }) as unknown as Project
const samples = (faces: FaceBox[]): FaceSample[] => [{ time: 5, faces }]

describe('C1: 人が決めた見え方(ぼかし背景)は触らない', () => {
  it('ぼかし背景を入れたクリップを、枠を埋める切り出しにしない', () => {
    const p = projectOf([
      { inPoint: 0, outPoint: 10, blurBackground: true },
      { inPoint: 10, outPoint: 20 }
    ])
    const r = applyVerticalFill(p, new Map([['c2', samples([face(0.7)])]]))
    expect(r.project.clips[0]).toEqual(p.clips[0])
    expect(r.project.clips[1].fillCrop).toBe(true)
  })
})

describe('C2: 文字だけ直したテロップも前後と同じ高さへ上げる', () => {
  it('直した枚(位置は決めていない)も上げ、位置を手で決めた枚は動かさない', () => {
    const p = projectOf(
      [{ inPoint: 0, outPoint: 30 }],
      [
        telop('t1', 1, 4),
        telop('t2', 5, 8, { edited: true }),
        telop('t3', 9, 12, {
          edited: true,
          style: { ...defaultTextStyle(), customPosition: { x: 0.5, y: 0.9 } }
        })
      ]
    )
    const r = applyVerticalFill(p, new Map())
    const [t1, t2, t3] = r.project.textOverlays
    expect(t1.style.customPosition!.y).toBeLessThan(0.84)
    expect(t2.style.customPosition).toEqual(t1.style.customPosition)
    expect(t3.style.customPosition).toEqual({ x: 0.5, y: 0.9 })
  })
})

describe('C3: ゲーム実況(企画の種類)は顔に寄せない', () => {
  it('企画に覚えた種類で決める', () => {
    expect(framesOnFaces(projectOf([], [], { autoEdit: { kind: 'game' } }))).toBe(false)
    expect(framesOnFaces(projectOf([], [], { autoEdit: { kind: 'location' } }))).toBe(true)
    expect(framesOnFaces(projectOf([]))).toBe(true)
  })
})

describe('C4: 顔を探す画の数を抑え、進み具合を出し、中止が効く', () => {
  it('2000本の仮編集でも、探す画は素材ごとの代表だけ(上限まで)', () => {
    const clips = Array.from({ length: 2000 }, (_, i) => ({
      inPoint: i * 1.5,
      outPoint: i * 1.5 + 1.2,
      assetId: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C'
    }))
    const p = {
      ...projectOf(clips),
      assets: [asset('A'), asset('B'), asset('C')]
    } as unknown as Project
    const plan = planFaceFrames(p)
    expect(plan.requests.length).toBeLessThanOrEqual(MAX_FACE_FRAMES)
    expect(plan.requests.length).toBeGreaterThan(3)
    // どのクリップも、近い代表の画を1〜3枚使う
    expect(plan.perClip.size).toBe(2000)
    for (const idx of plan.perClip.values()) {
      expect(idx.length).toBeGreaterThanOrEqual(1)
      expect(idx.length).toBeLessThanOrEqual(3)
    }
  })

  it('少しずつ探して進み具合を出し、中止すれば止まる', async () => {
    const progress: number[] = []
    const ctrl = new AbortController()
    let calls = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        faceDetect: async (req: unknown[]) => {
          calls++
          if (calls === 2) ctrl.abort()
          return req.map(() => [face(0.5)])
        }
      }
    }
    const reqs = Array.from({ length: 30 }, (_, i) => ({
      path: '/r/A.mp4',
      time: i,
      width: 1920,
      height: 1080
    }))
    await expect(
      detectFaceFrames(reqs, { signal: ctrl.signal, onProgress: (d) => progress.push(d) })
    ).rejects.toThrow('EXPORT_CANCELED')
    expect(calls).toBe(2)
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBeGreaterThan(0)
  })
})

describe('C5: 書き出し画面の見本も書き出しと同じ切り出し', () => {
  it('顔に寄せる所・人が決めた黒帯の所を、それぞれの切り出しで返す', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { faceDetect: async (req: unknown[]) => req.map(() => [face(0.75)]) }
    }
    const p = projectOf([
      { inPoint: 0, outPoint: 10 },
      { inPoint: 100, outPoint: 110, fillCrop: false }
    ])
    const list = await verticalSamples(p, [5, 15], true)
    expect(list).toHaveLength(2)
    expect(list[0].fill).toBe(true)
    expect(list[0].center.x).toBeGreaterThan(0.7)
    expect(list[1].fill).toBe(false)
    // 顔に寄せない設定(黒帯)なら、見本も黒帯
    const off = await verticalSamples(p, [5], false)
    expect(off[0].fill).toBe(false)
  })
})

describe('C6・C7: 自動のショート', () => {
  it('組み立てが真ん中で埋めたクリップを顔に寄せ直し、顔を避けてテロップを置く(静止画・縦の素材はそのまま埋める)', async () => {
    // 顔が画面の下まで大きく映る
    const low = face(0.45, 0.65, 0.1, 0.2)
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { faceDetect: async (req: unknown[]) => req.map(() => [low]) }
    }
    const p = projectOf(
      [
        { inPoint: 0, outPoint: 10, fillCrop: true },
        { inPoint: 0, outPoint: 3, fillCrop: true, assetId: 'S' },
        { inPoint: 0, outPoint: 5, fillCrop: true, assetId: 'V' }
      ],
      [telop('t1', 2, 5)]
    )
    const r = await prepareVerticalFill(p, { refineAutoFill: true, alwaysLift: true })
    const [c1, c2, c3] = r.project.clips
    expect(c1.cropCenter!.x).toBeCloseTo(0.5, 1)
    expect(r.onFaces).toBe(1)
    expect(c2).toEqual(p.clips[1])
    expect(c3).toEqual(p.clips[2])
    // 顔に掛かるので上へ(組み立てが先に高さを決めていると、顔を避けられなかった)
    expect(r.project.textOverlays[0].style.position).toBe('top')
    expect(r.movedTelops).toBe(1)
  })
})

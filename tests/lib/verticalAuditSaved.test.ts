import { describe, expect, it } from 'vitest'
import {
  applyVerticalFill,
  verticalSamples,
  withoutVerticalSplits
} from '@renderer/lib/verticalFraming'
import { scaleToFrameFilter } from '@shared/videoFrame'
import type { FaceBox } from '@shared/telop/avoidFaces'
import type { Project } from '@shared/types'

/**
 * 監査の指摘 3: 自動のショートで保存した企画に、上下に積む形と話す人で分けたクリップが残り、16:9 にしても
 * 書き出しの画面で「1人に寄せる」「黒帯」を選んでも、積んだまま・分けたまま書き出していた
 */
const face = (x: number): FaceBox => ({ x, y: 0.3, w: 0.08, h: 0.128, score: 0.9 })
const project = {
  id: 'p',
  name: 'short',
  aspectRatio: '9:16',
  assets: [
    {
      id: 'A',
      filePath: '/a.mp4',
      fileName: 'a.mp4',
      duration: 600,
      width: 640,
      height: 360,
      fps: 30,
      hasAudio: true,
      hasVideo: true
    }
  ],
  clips: [
    { id: 'c1', assetId: 'A', inPoint: 100, outPoint: 120, speed: 1 },
    { id: 'c2', assetId: 'A', inPoint: 200, outPoint: 220, speed: 1 }
  ],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: []
} as unknown as Project
const faces = new Map(
  [
    ['c1', 105],
    ['c2', 205]
  ].map(([id, t]) => [id as string, [{ time: t as number, faces: [face(0.15), face(0.75)] }]])
)
const saved = applyVerticalFill(project, faces, {
  speakers: {
    faces: new Map([
      [
        'A',
        new Map([
          ['甲', 0.19],
          ['乙', 0.79]
        ])
      ]
    ]),
    lines: [
      { speaker: '甲', start: 0, end: 8 },
      { speaker: '乙', start: 8.5, end: 20 }
    ]
  }
}).project
// c2 は話者が分からず上下に積む形のまま(c1 は話す人で分けた)
const savedStack = {
  ...saved,
  clips: saved.clips.map((c) =>
    c.id === 'c2' ? applyVerticalFill(project, faces).project.clips[1] : c
  )
}

describe('保存した企画の積む形・分けたクリップ', () => {
  it('前提: 分けたクリップと積む形が企画に残る', () => {
    expect(savedStack.clips.map((c) => c.id)).toEqual(['c1', 'c1~v1', 'c2'])
    expect(savedStack.clips[2].splitStack).toBeDefined()
  })

  it('元の形に戻す: 分けたクリップはつなぎ、積む形は外す', () => {
    const plain = withoutVerticalSplits(savedStack)
    expect(plain.clips.map((c) => [c.id, c.inPoint, c.outPoint])).toEqual([
      ['c1', 100, 120],
      ['c2', 200, 220]
    ])
    expect(plain.clips.every((c) => !c.splitStack)).toBe(true)
    // 企画は変えない
    expect(savedStack.clips).toHaveLength(3)
  })

  it('2本目に人が変えた設定(音を分けた・ぼかし背景・色ラベル・頭の繋ぎ)があればつながず、積む形だけ外す(再監査の指摘 3)', () => {
    for (const extra of [
      { audioDetached: true },
      { blurBackground: true },
      { colorLabel: 'red' as const },
      { transitionIn: { type: 'crossfade' as const, duration: 0.5 } }
    ]) {
      const edited = {
        ...savedStack,
        clips: savedStack.clips.map((c) => (c.id === 'c1~v1' ? { ...c, ...extra } : c))
      }
      const plain = withoutVerticalSplits(edited)
      expect(plain.clips.map((c) => c.id)).toEqual(['c1', 'c1~v1', 'c2'])
      expect(plain.clips[1]).toMatchObject(extra)
      expect(plain.clips.every((c) => !c.splitStack)).toBe(true)
    }
  })

  it('縦でない出力(16:9 にした企画)では積まない', () => {
    const stack = savedStack.clips[2].splitStack!
    expect(
      scaleToFrameFilter(1920, 1080, true, { x: 0.2, y: 0.5 }, false, { stack })
    ).not.toContain('vstack')
    expect(scaleToFrameFilter(1080, 1920, true, { x: 0.2, y: 0.5 }, false, { stack })).toContain(
      'vstack'
    )
  })

  it('書き出し画面の見本も、「1人に寄せる」なら積まない', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { faceDetect: async (req: unknown[]) => req.map(() => [face(0.15), face(0.75)]) }
    }
    const one = await verticalSamples(savedStack, [25], true, true, undefined, false)
    expect(one[0].stack).toBeUndefined()
    const two = await verticalSamples(savedStack, [25], true, true, undefined, true)
    expect(two[0].stack).toBeDefined()
  })
})

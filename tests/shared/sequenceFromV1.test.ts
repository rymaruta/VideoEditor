import { describe, expect, it } from 'vitest'
import type { MediaAsset, Project } from '@shared/types'
import { defaultTextStyle } from '@shared/textStyle'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { telopItemSource } from '@shared/telop/layer'
import { telopMotionAt } from '@shared/telop/render'
import { computeMainTrackLayout } from '@shared/mainTrackLayout'
import type { ItemBase, MediaItem, ProjectV2 } from '@shared/sequence/types'
import { seeded } from '../helpers/boundary'

const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  filePath: `/media/${id}.mp4`,
  fileName: `${id}.mp4`,
  duration: 600,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  hasVideo: true,
  ...extra
})

const emptyProject = (extra: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'テスト',
  aspectRatio: '16:9',
  assets: [
    asset('a'),
    asset('b'),
    asset('mute', { hasAudio: false }),
    asset('bgm', { hasVideo: false })
  ],
  clips: [],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: [],
  ...extra
})

/** 5秒2本を1秒のクロスフェードで繋いだ本編(書き出しの並びは [0,5] と [4,9]、総尺9秒=270フレーム) */
const crossfadeClips = (): Project['clips'] => [
  { id: 'c1', assetId: 'a', inPoint: 10, outPoint: 15, speed: 1 },
  {
    id: 'c2',
    assetId: 'b',
    inPoint: 0,
    outPoint: 5,
    speed: 1,
    transitionIn: { type: 'crossfade', duration: 1 }
  }
]

const tracksOf = (p: ProjectV2): ItemBase[][] => [
  ...p.sequence.videoTracks.map((t) => t.items),
  ...p.sequence.audioTracks.map((t) => t.items)
]

describe('projectV1ToV2 — v1 を v2 へ、書き出しと同じ位置で写す', () => {
  it('シーケンスの大きさ・フレームレート', () => {
    const p = projectV1ToV2(emptyProject({ clips: crossfadeClips() }))
    expect(p.version).toBe(2)
    expect(p.sequence).toMatchObject({ width: 1920, height: 1080, fps: { num: 30, den: 1 } })
    const vertical = projectV1ToV2(emptyProject({ aspectRatio: '9:16', clips: crossfadeClips() }), {
      resolution: 720
    })
    expect(vertical.sequence).toMatchObject({ width: 720, height: 1280 })
  })

  it('本編は V1 に入り、繋ぎのぶん手前と重なる', () => {
    const p = projectV1ToV2(emptyProject({ clips: crossfadeClips() }))
    const v1 = p.sequence.videoTracks[0].items as MediaItem[]
    expect(v1.map((i) => [i.id, i.startFrame, i.durationFrames])).toEqual([
      ['c1', 0, 150],
      ['c2', 120, 150]
    ])
    expect(v1[0].sourceIn).toBe(10)
    expect(v1[1].transitionIn).toEqual({ type: 'crossfade', durationFrames: 30 })
    expect(v1[0].placement).toEqual({ kind: 'frame', fit: 'contain' })
  })

  it('クロップ・ぼかし背景・色ラベルを引き継ぐ', () => {
    const p = projectV1ToV2(
      emptyProject({
        clips: [
          {
            id: 'c1',
            assetId: 'a',
            inPoint: 0,
            outPoint: 2,
            speed: 1,
            fillCrop: true,
            cropCenter: { x: 0.3, y: 0.6 },
            colorLabel: 'red'
          },
          { id: 'c2', assetId: 'a', inPoint: 0, outPoint: 2, speed: 1, blurBackground: true }
        ]
      })
    )
    const [c1, c2] = p.sequence.videoTracks[0].items as MediaItem[]
    expect(c1.placement).toEqual({ kind: 'frame', fit: 'cover', cropCenter: { x: 0.3, y: 0.6 } })
    expect(c1.colorLabel).toBe('red')
    expect(c2.placement).toEqual({ kind: 'frame', fit: 'contain', blurBackground: true })
  })

  it('本編の音は A1 に同じ位置で入り、映像に紐づく。音の無い素材・分離済みは入らない', () => {
    const p = projectV1ToV2(
      emptyProject({
        clips: [
          ...crossfadeClips(),
          { id: 'c3', assetId: 'mute', inPoint: 0, outPoint: 1, speed: 1 },
          { id: 'c4', assetId: 'a', inPoint: 0, outPoint: 1, speed: 1, audioDetached: true }
        ]
      })
    )
    const a1 = p.sequence.audioTracks[0]
    expect(a1.id).toBe('a1-main')
    expect(a1.items.map((i) => [i.linkedItemId, i.startFrame, i.durationFrames])).toEqual([
      ['c1', 0, 150],
      ['c2', 120, 150]
    ])
  })

  it('全面(版面CG)のワイプは、画面に収める置き方(縁なし・縦横比を保つ)になる', () => {
    const p = projectV1ToV2(
      emptyProject({
        clips: crossfadeClips(),
        videoOverlayTracks: [
          {
            id: 'cg',
            name: 'CG',
            hidden: false,
            position: 'full',
            scale: 1,
            clips: [{ id: 'c1', assetId: 'a', startTime: 1, inPoint: 0, outPoint: 2 }]
          }
        ]
      })
    )
    const cg = p.sequence.videoTracks.find((t) => t.id === 'cg')!
    expect((cg.items[0] as MediaItem).placement).toEqual({ kind: 'frame', fit: 'contain' })
  })

  it('ワイプの音のアイテムにも出点を渡す(フレームに丸めて伸びたぶん、出点の先の音を読まない)', () => {
    const p = projectV1ToV2(
      emptyProject({
        clips: crossfadeClips(),
        videoOverlayTracks: [
          {
            id: 'w',
            name: 'ワイプ',
            hidden: false,
            position: 'bottom-right',
            scale: 0.3,
            clips: [{ id: 'p1', assetId: 'a', startTime: 1, inPoint: 3.012, outPoint: 4.5 }]
          }
        ]
      })
    )
    const audio = p.sequence.audioTracks.flatMap((t) => t.items).find((it) => it.id === 'p1:audio')
    expect(audio?.sourceOut).toBe(4.5)
  })

  it('速くしたワイプは、タイムラインの長さ(素材の秒数 ÷ 速さ)で置き、絵も音も同じ速さで流す', () => {
    const p = projectV1ToV2(
      emptyProject({
        clips: crossfadeClips(),
        videoOverlayTracks: [
          {
            id: 'face',
            name: '顔',
            hidden: false,
            position: 'bottom-right',
            scale: 0.26,
            // 素材 2〜8 秒(6秒)を2倍で → タイムライン 1〜4 秒(書き出しも同じ。繋ぎより前)
            clips: [{ id: 'f1', assetId: 'a', startTime: 1, inPoint: 2, outPoint: 8, speed: 2 }]
          }
        ]
      })
    )
    const item = p.sequence.videoTracks
      .flatMap((t) => t.items)
      .find((it) => it.id === 'f1') as MediaItem
    expect(item).toMatchObject({ startFrame: 30, durationFrames: 90, sourceIn: 2, speed: 2 })
    const audio = p.sequence.audioTracks.flatMap((t) => t.items).find((it) => it.id === 'f1:audio')
    expect(audio).toMatchObject({
      startFrame: 30,
      durationFrames: 90,
      sourceIn: 2,
      sourceOut: 8,
      speed: 2
    })
  })

  it('PiP は本編の尺で頭打ち。v1 の同じトラックで重なっていれば段を分ける', () => {
    const p = projectV1ToV2(
      emptyProject({
        clips: crossfadeClips(),
        videoOverlayTracks: [
          {
            id: 'pip',
            name: 'ワイプ',
            hidden: false,
            position: 'bottom-right',
            scale: 0.3,
            clips: [
              // 6秒(タイムライン) → 書き出し5秒から。4秒ぶんのうち本編の尺(9秒)まで=4秒
              { id: 'p1', assetId: 'a', startTime: 6, inPoint: 0, outPoint: 4 },
              // 7秒から → 重なるので2段目
              { id: 'p2', assetId: 'b', startTime: 7, inPoint: 0, outPoint: 10 }
            ]
          }
        ]
      })
    )
    const [, pip1, pip2] = p.sequence.videoTracks
    expect(pip1.id).toBe('pip')
    expect(pip2.id).toBe('pip:2')
    const [p1] = pip1.items as MediaItem[]
    expect([p1.startFrame, p1.durationFrames]).toEqual([150, 120])
    expect(p1.placement).toEqual({ kind: 'box', anchor: 'bottom-right', margin: 0.04, width: 0.3 })
    // 書き出し6秒から、本編の終わり(9秒)で切られて3秒
    expect([pip2.items[0].startFrame, pip2.items[0].durationFrames]).toEqual([180, 90])
  })

  it('ワイプの音は専用の音声トラックに同じ位置で入る。非表示のワイプはミュート、音の無い素材は入らない', () => {
    const pipTrack = (
      id: string,
      hidden: boolean,
      assetId: string
    ): Project['videoOverlayTracks'][number] => ({
      id,
      name: id,
      hidden,
      position: 'top-left',
      scale: 0.3,
      clips: [{ id: `${id}-c`, assetId, startTime: 1, inPoint: 2, outPoint: 4 }]
    })
    const p = projectV1ToV2(
      emptyProject({
        clips: crossfadeClips(),
        videoOverlayTracks: [
          pipTrack('shown', false, 'a'),
          pipTrack('hidden', true, 'b'),
          pipTrack('silent', false, 'mute'),
          // 顔カメラ: 絵は出すが音は鳴らさない
          { ...pipTrack('face', false, 'a'), audioMuted: true }
        ]
      })
    )
    const byId = new Map(p.sequence.audioTracks.map((t) => [t.id, t]))
    expect(byId.get('shown:audio')).toMatchObject({ muted: false, duckingEnabled: false })
    expect(byId.get('shown:audio')!.items[0]).toMatchObject({
      linkedItemId: 'shown-c',
      startFrame: 30,
      durationFrames: 60,
      sourceIn: 2
    })
    expect(byId.get('hidden:audio')?.muted).toBe(true)
    expect(byId.get('face:audio')?.muted).toBe(true)
    expect(byId.has('silent:audio')).toBe(false)
  })

  it('同じトラックで重なるワイプは、並びで後のものを手前の段に置く(プレビュー・標準の書き出しと同じ)', () => {
    const p = projectV1ToV2(
      emptyProject({
        clips: [{ id: 'c1', assetId: 'a', inPoint: 0, outPoint: 9, speed: 1 }],
        videoOverlayTracks: [
          {
            id: 'pip',
            name: 'PiP',
            hidden: false,
            position: 'top-left',
            scale: 0.4,
            clips: [
              { id: 'red', assetId: 'a', startTime: 3, inPoint: 0, outPoint: 3 },
              { id: 'blue', assetId: 'b', startTime: 0, inPoint: 0, outPoint: 5 }
            ]
          }
        ]
      })
    )
    const laneOf = (id: string): number =>
      p.sequence.videoTracks.findIndex((t) => t.items.some((i) => i.id === id))
    expect(laneOf('blue')).toBeGreaterThan(laneOf('red'))
  })

  it('本編の終わりで切ったテロップの消える動きは、切る前の終わりから数える(プレビューと同じ)', () => {
    const p = projectV1ToV2(
      emptyProject({
        clips: [{ id: 'c1', assetId: 'a', inPoint: 0, outPoint: 5, speed: 1 }],
        textOverlays: [
          {
            id: 't1',
            text: 'あ',
            startTime: 4,
            endTime: 8,
            style: { ...defaultTextStyle(), exitAnimation: 'fadeOut' },
            source: 'manual'
          }
        ]
      } as Partial<Project>)
    )
    const item = p.sequence.videoTracks
      .flatMap((t) => t.items)
      .find((i) => i.id === 't1')! as Parameters<typeof telopItemSource>[0]
    // 見えるのは本編の終わり(5秒)まで
    expect(item.startFrame + item.durationFrames).toBe(150)
    const src = telopItemSource(item, 30)
    const last = 149 / 30
    const m = telopMotionAt(src.style, last - src.startTime, src.endTime - last, 1080)
    // プレビューは終わりが 8 秒なので、5 秒の手前ではまだ消え始めていない
    expect(m.opacity).toBeCloseTo(1, 6)
  })

  it('半コマより短い音のフェード(切れ目の 20ms)も、0 コマに丸めない', () => {
    const p = projectV1ToV2(
      emptyProject({
        assets: [asset('a', { fps: 24 }), asset('bgm', { hasVideo: false })],
        clips: [{ id: 'c1', assetId: 'a', inPoint: 0, outPoint: 10, speed: 1 }],
        audioTracks: [
          {
            id: 'mic',
            name: 'マイク',
            volume: 1,
            muted: false,
            duckingEnabled: false,
            clips: [
              { id: 'm1', assetId: 'bgm', startTime: 0, inPoint: 0, outPoint: 2, fadeOut: 0.02 },
              { id: 'm2', assetId: 'bgm', startTime: 2, inPoint: 5, outPoint: 7, fadeIn: 0.02 }
            ]
          }
        ]
      } as Partial<Project>)
    )
    const items = p.sequence.audioTracks.find((t) => t.id === 'mic')!.items
    expect(items.find((i) => i.id === 'm1')!.fadeOutFrames).toBeGreaterThanOrEqual(1)
    expect(items.find((i) => i.id === 'm2')!.fadeInFrames).toBeGreaterThanOrEqual(1)
  })

  it('テロップは書き出しの秒へ換算し、単語の時刻はアイテムの頭からの秒にする', () => {
    const p = projectV1ToV2(
      emptyProject({
        clips: crossfadeClips(),
        textOverlays: [
          {
            id: 't1',
            text: 'こんにちは',
            startTime: 6,
            endTime: 8,
            style: defaultTextStyle(),
            source: 'auto',
            words: [
              { text: 'こん', start: 6, end: 7 },
              { text: 'にちは', start: 7, end: 8 }
            ]
          },
          // 本編の後ろ(書き出し 9秒以降)だけに居るテロップは消える
          { id: 't2', text: '後ろ', startTime: 10.5, endTime: 12, style: defaultTextStyle() }
        ]
      })
    )
    const telopTracks = p.sequence.videoTracks.filter((t) => t.id.startsWith('telop-'))
    expect(telopTracks).toHaveLength(1)
    const [t1] = telopTracks[0].items
    expect(t1).toMatchObject({
      kind: 'telop',
      id: 't1',
      startFrame: 150,
      durationFrames: 60,
      origin: 'auto'
    })
    if (t1.kind !== 'telop') throw new Error('telop')
    expect(t1.words).toEqual([
      { text: 'こん', start: 0, end: 1 },
      { text: 'にちは', start: 1, end: 2 }
    ])
  })

  it('音声トラック: 位置の換算・本編の尺での頭打ち・フェード・紐づけを引き継ぐ', () => {
    const p = projectV1ToV2(
      emptyProject({
        clips: crossfadeClips(),
        audioTracks: [
          {
            id: 'bgm',
            name: 'BGM',
            muted: false,
            volume: 0.5,
            duckingEnabled: true,
            clips: [
              {
                id: 'm1',
                assetId: 'bgm',
                startTime: 0,
                inPoint: 0,
                outPoint: 60,
                fadeIn: 1,
                volume: 0.8
              },
              { id: 'd1', assetId: 'a', startTime: 6, inPoint: 0, outPoint: 1, linkedClipId: 'c2' }
            ]
          }
        ]
      })
    )
    const bgm = p.sequence.audioTracks.find((t) => t.id === 'bgm')!
    expect(bgm).toMatchObject({ volume: 0.5, duckingEnabled: true })
    const [m1] = bgm.items
    // 60秒の BGM は本編の尺 9秒=270フレームで切れる
    expect(m1).toMatchObject({ startFrame: 0, durationFrames: 270, fadeInFrames: 30, volume: 0.8 })
    // 分離音声は BGM と重なるので2段目へ。トラックの設定は1段目と同じ
    const bgm2 = p.sequence.audioTracks.find((t) => t.id === 'bgm:2')!
    expect(bgm2).toMatchObject({ name: 'BGM (2)', volume: 0.5, duckingEnabled: true })
    expect(bgm2.items).toHaveLength(1)
    expect(bgm2.items[0]).toMatchObject({
      id: 'd1',
      startFrame: 150,
      durationFrames: 30,
      linkedItemId: 'c2'
    })
  })

  it('素材の見つからないクリップは飛ばして続ける(開けないファイルにしない)', () => {
    const p = projectV1ToV2(
      emptyProject({
        clips: [
          { id: 'c1', assetId: 'a', inPoint: 0, outPoint: 2, speed: 1 },
          { id: 'gone', assetId: 'missing', inPoint: 0, outPoint: 2, speed: 1 },
          { id: 'c3', assetId: 'a', inPoint: 0, outPoint: 2, speed: 1 }
        ]
      })
    )
    expect(p.sequence.videoTracks[0].items.map((i) => [i.id, i.startFrame])).toEqual([
      ['c1', 0],
      ['c3', 60]
    ])
  })

  it('空の企画でも落ちない', () => {
    const p = projectV1ToV2(emptyProject())
    expect(p.sequence.videoTracks).toHaveLength(1)
    expect(p.sequence.videoTracks[0].items).toEqual([])
    expect(p.sequence.audioTracks).toEqual([])
  })

  it('【不変条件】本編の境目は v1 の書き出し位置から半フレーム以内(長い企画でも積み上がらない)', () => {
    const rnd = seeded(31)
    for (let n = 0; n < 200; n++) {
      const clips: Project['clips'] = Array.from(
        { length: 50 + Math.floor(rnd() * 150) },
        (_, i) => ({
          id: `c${i}`,
          assetId: 'a',
          inPoint: 0,
          outPoint: 0.3 + rnd() * 5,
          speed: 1,
          transitionIn: rnd() < 0.3 ? { type: 'fade', duration: rnd() * 0.8 } : undefined
        })
      )
      const p = projectV1ToV2(emptyProject({ clips }))
      const layout = computeMainTrackLayout(clips, 30)
      const items = p.sequence.videoTracks[0].items
      expect(items).toHaveLength(clips.length)
      items.forEach((it, i) => {
        expect(Math.abs(it.startFrame - layout.exportStarts[i] * 30)).toBeLessThanOrEqual(
          0.5 + 1e-9
        )
        expect(
          Math.abs(it.startFrame + it.durationFrames - layout.exportEnds[i] * 30)
        ).toBeLessThanOrEqual(0.5 + 1e-9)
      })
    }
  })

  it('【不変条件】トラック内の重なりは本編の繋ぎの区間の中だけ・尺は1フレーム以上・本編の尺に収まる', () => {
    const rnd = seeded(20261002)
    for (let n = 0; n < 500; n++) {
      const clips: Project['clips'] = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => {
        const inPoint = rnd() * 100
        return {
          id: `c${i}`,
          assetId: rnd() < 0.5 ? 'a' : 'b',
          inPoint,
          outPoint: inPoint + 0.05 + rnd() * 8,
          speed: rnd() < 0.2 ? 2 : 1,
          transitionIn: rnd() < 0.5 ? { type: 'crossfade', duration: rnd() * 2 } : undefined
        }
      })
      const randomSpan = (): { startTime: number; inPoint: number; outPoint: number } => ({
        startTime: rnd() * 40,
        inPoint: 0,
        outPoint: 0.1 + rnd() * 10
      })
      const p = projectV1ToV2(
        emptyProject({
          clips,
          videoOverlayTracks: [
            {
              id: 'pip',
              name: 'PiP',
              hidden: false,
              position: 'top-left',
              scale: 0.25,
              clips: Array.from({ length: Math.floor(rnd() * 5) }, (_, i) => ({
                id: `p${i}`,
                assetId: 'a',
                ...randomSpan()
              }))
            }
          ],
          audioTracks: [
            {
              id: 'bgm',
              name: 'BGM',
              muted: false,
              volume: 1,
              duckingEnabled: false,
              clips: Array.from({ length: Math.floor(rnd() * 5) }, (_, i) => ({
                id: `m${i}`,
                assetId: 'bgm',
                ...randomSpan()
              }))
            }
          ],
          textOverlays: Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => {
            const s = rnd() * 40
            return {
              id: `t${i}`,
              text: 'x',
              startTime: s,
              endTime: s + rnd() * 5,
              style: defaultTextStyle()
            }
          })
        })
      )
      const total = p.sequence.videoTracks[0].items.reduce(
        (m, i) => Math.max(m, i.startFrame + i.durationFrames),
        0
      )
      // 繋ぎの区間 [始まり, 始まり+繋ぎ)。本編の音も映像と同じ区間で重なる
      const transitionWindows = (p.sequence.videoTracks[0].items as MediaItem[])
        .filter((v) => v.transitionIn)
        .map((v) => [v.startFrame, v.startFrame + v.transitionIn!.durationFrames])
      const insideTransition = (a: number, b: number): boolean =>
        transitionWindows.some(([s, e]) => a >= s && b <= e)
      for (const items of tracksOf(p)) {
        for (const it of items) {
          expect(it.durationFrames).toBeGreaterThanOrEqual(1)
          expect(it.startFrame).toBeGreaterThanOrEqual(0)
          expect(it.startFrame + it.durationFrames).toBeLessThanOrEqual(total)
        }
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            const a = Math.max(items[i].startFrame, items[j].startFrame)
            const b = Math.min(
              items[i].startFrame + items[i].durationFrames,
              items[j].startFrame + items[j].durationFrames
            )
            if (b > a) expect(insideTransition(a, b)).toBe(true)
          }
        }
      }
    }
  })
})

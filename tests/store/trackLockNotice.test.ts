import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '@renderer/store/projectStore'
import { autoFinishTimeline } from '@renderer/lib/autoFinish'
import { lockRefusalMessage } from '@renderer/lib/trackLock'
import type { AudioTrack, MediaAsset, Project } from '@shared/types'

/**
 * ストアがトラックの固定を理由に書き込みを断ったら、必ず知らせる(`lockRefusal`)。
 * 黙って何も起きないことにしない: メニューバーの「テロップを追加」・ナレーション・自動の仕上げなど、
 * 画面のボタンを押せなくできない経路でも、断った数が増えて帯に出る
 */

const asset: MediaAsset = {
  id: 'a',
  filePath: '/x/a.mp4',
  fileName: 'a.mp4',
  duration: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  hasVideo: true
}

const track = (id: string, name: string): AudioTrack => ({
  id,
  name,
  muted: false,
  volume: 1,
  duckingEnabled: false,
  clips: [{ id: `${id}-c`, assetId: 'a', startTime: 0, inPoint: 0, outPoint: 2, volume: 1 }]
})

const project = (): Project => ({
  id: 'p',
  name: 'p',
  aspectRatio: '16:9',
  assets: [asset],
  clips: [{ id: 'c1', assetId: 'a', inPoint: 0, outPoint: 4, speed: 1 }],
  audioTracks: [track('n', 'ナレーション'), track('b', 'BGM')],
  videoOverlayTracks: [],
  textOverlays: []
})

const s = useProjectStore.getState
const telop = { text: 'あ', startTime: 0, endTime: 1, style: {} as never }

beforeEach(() => {
  useProjectStore.setState({ project: project(), past: [], future: [], lockRefusal: null })
})

describe('固定を理由に断ったら知らせる', () => {
  it('メニューバーの「テロップを追加」と同じ書き込み: 断り、数を数えて知らせる', () => {
    s().toggleTrackLocked({ kind: 'telop' })
    s().addTextOverlay(telop)
    expect(s().project.textOverlays).toHaveLength(0)
    expect(s().lockRefusal).toEqual({ count: 1, names: ['テロップ'], partial: false })
    s().addTextOverlay(telop)
    expect(s().lockRefusal?.count).toBe(2)
    expect(lockRefusalMessage(s().lockRefusal!)).toBe(
      'テロップは固定されています。外してから操作してください'
    )
  })

  it('ナレーションを足す(名前で選ぶトラック)も、固定していれば断って知らせる', () => {
    s().toggleTrackLocked({ kind: 'audio', id: 'n' })
    s().addAudioClipWithAsset(asset, { trackName: 'ナレーション', startTime: 5 })
    expect(s().project.audioTracks[0].clips).toHaveLength(1)
    expect(s().lockRefusal?.names).toEqual(['ナレーション'])
  })

  it('本編を変える書き込みは丸ごと断って知らせる', () => {
    s().toggleTrackLocked({ kind: 'main' })
    s().updateClipSpeed('c1', 2)
    expect(s().lockRefusal).toMatchObject({ names: ['本編'], partial: false })
  })

  it('複数のトラックに書いて、固定したトラックだけ変わらなかったときも知らせる(partial)', () => {
    s().toggleTrackLocked({ kind: 'audio', id: 'b' })
    const p = s().project
    // 2 つのトラックへ同時に書く(範囲の自動編集が組んだ企画を当てるのと同じ書き込み。自動の仕上げも同じ形)
    expect(
      s().applyRangedProject(
        { ...p, audioTracks: p.audioTracks.map((t) => ({ ...t, clips: [] })) },
        p
      )
    ).toBe(true)
    expect(s().project.audioTracks[0].clips).toHaveLength(0)
    expect(s().project.audioTracks[1].clips).toHaveLength(1)
    expect(s().lockRefusal).toMatchObject({ names: ['BGM'], partial: true })
    expect(lockRefusalMessage(s().lockRefusal!)).toBe(
      'BGMは固定されているため変わりませんでした。外してから操作してください'
    )
  })

  it('固定していなければ知らせない', () => {
    s().addTextOverlay(telop)
    s().updateClipSpeed('c1', 2)
    expect(s().lockRefusal).toBeNull()
  })
})

describe('自動の仕上げ', () => {
  const g = globalThis as unknown as { window?: unknown }
  let had: unknown
  beforeEach(() => {
    had = g.window
    g.window = {
      api: { transcribe: async () => [{ start: 0, end: 1, text: 'こんにちは' }] }
    }
  })
  afterEach(() => {
    g.window = had
  })

  it('テロップを固定していると、作ったテロップは置かれず、そのことを知らせる', async () => {
    s().toggleTrackLocked({ kind: 'telop' })
    await autoFinishTimeline(undefined, 'ja')
    expect(s().project.textOverlays).toHaveLength(0)
    expect(s().lockRefusal?.names).toEqual(['テロップ'])
  })
})

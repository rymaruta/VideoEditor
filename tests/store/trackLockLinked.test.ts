import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '@renderer/store/projectStore'
import type { AudioTrack, MediaAsset, Project } from '@shared/types'

/**
 * a064400 の再確認(zProbe9 の probe・probe2)を期待値付きで取り込んだもの:
 * - 固定した音声トラックの紐づいたクリップは、本編と一緒のときだけ動く。単独で動かす・トリムする・
 *   紐づきを外すのは断る(クリップが消えていた)
 * - 断った書き込みでテロップの並び(重なりの上下)を変えない。中身が変わらなければ履歴に積まない
 * - 取り消し・やり直しで固定に戻ったら、固定したトラックの選びを外す
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

const audioTrack = (id: string, extra: Partial<AudioTrack> = {}): AudioTrack => ({
  id,
  name: id,
  muted: false,
  volume: 1,
  duckingEnabled: false,
  clips: [],
  ...extra
})

const project = (extra: Partial<Project> = {}): Project => ({
  id: 'p',
  name: 'p',
  aspectRatio: '16:9',
  assets: [asset],
  clips: [
    { id: 'c1', assetId: 'a', inPoint: 0, outPoint: 4, speed: 1 },
    { id: 'c2', assetId: 'a', inPoint: 4, outPoint: 8, speed: 1 }
  ],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: [],
  ...extra
})

const s = useProjectStore.getState
const clipsOf = (): [string, number, number, string | null][] =>
  s().project.audioTracks[0].clips.map((c) => [
    c.id,
    c.startTime,
    c.volume ?? 1,
    c.linkedClipId ?? null
  ])

const mk = (): void => {
  const pr = project({
    audioTracks: [
      audioTrack('a1', {
        clips: [
          { id: 'own', assetId: 'a', startTime: 9, inPoint: 0, outPoint: 1, volume: 1 },
          {
            id: 'lnk',
            assetId: 'a',
            startTime: 4,
            inPoint: 4,
            outPoint: 8,
            volume: 1,
            linkedClipId: 'c2'
          }
        ]
      })
    ]
  })
  useProjectStore.setState({ project: pr, past: [], future: [], lockRefusal: null })
  s().toggleTrackLocked({ kind: 'audio', id: 'a1' })
}

const BEFORE: [string, number, number, string | null][] = [
  ['own', 9, 1, null],
  ['lnk', 4, 1, 'c2']
]

beforeEach(mk)

describe('固定した音声トラックの紐づいたクリップ', () => {
  it.each([
    ['音量', () => s().updateAudioClipVolume('a1', 'lnk', 0.2)],
    ['開始位置', () => s().updateAudioClipStart('a1', 'lnk', 1)],
    ['トリム', () => s().updateAudioClipTrim('a1', 'lnk', 5, 8)],
    ['紐づきを外す', () => s().unlinkAudioClip('a1', 'lnk')]
  ])('%s: 単独では変わらず、消えもしない(知らせる)', (_name, run) => {
    const past = s().past.length
    run()
    expect(clipsOf()).toEqual(BEFORE)
    expect(s().past.length).toBe(past)
    expect(s().lockRefusal).toMatchObject({ names: ['a1'], partial: false })
  })

  it('本編を分割・削除したときは、本編と一緒に切れる・動く(紐づかないクリップは前のまま)', () => {
    s().splitClipAtTime('c2', 6)
    const afterSplit = s().project.audioTracks[0].clips
    expect(afterSplit.filter((c) => c.linkedClipId)).toHaveLength(2)
    expect(afterSplit[0]).toMatchObject({ id: 'own', startTime: 9 })
    s().removeClip('c1')
    const linked = s()
      .project.audioTracks[0].clips.filter((c) => c.linkedClipId)
      .map((c) => c.startTime)
    expect(linked).toEqual([0, 2])
    expect(s().project.audioTracks[0].clips.find((c) => c.id === 'own')?.startTime).toBe(9)
  })
})

describe('断った書き込みは並びを変えない', () => {
  it('テロップの重なりの上下はそのまま。履歴に積まず、「一部」とは出さない', () => {
    const t = (id: string, st: number): never =>
      ({ id, text: id, startTime: st, endTime: st + 1, style: {} }) as never
    useProjectStore.setState({
      project: project({ textOverlays: [t('t2', 5), t('t1', 0)] }),
      past: [],
      future: [],
      lockRefusal: null
    })
    s().toggleTrackLocked({ kind: 'telop' })
    const past = s().past.length
    s().updateTextOverlay('t1', { text: 'x' })
    expect(s().project.textOverlays.map((o) => o.id)).toEqual(['t2', 't1'])
    expect(s().project.textOverlays[1].text).toBe('t1')
    expect(s().past.length).toBe(past)
    expect(s().lockRefusal).toMatchObject({ names: ['テロップ'], partial: false })
  })

  it('中身が変わらない書き込みでは帯を出さない', () => {
    s().setAudioTrackVolume('a1', s().project.audioTracks[0].volume)
    expect(s().lockRefusal).toBeNull()
  })
})

describe('取り消し・やり直しで固定に戻ったとき', () => {
  it('固定を取り消す → 選ぶ → やり直す、で本編の選びは外れる', () => {
    s().toggleTrackLocked({ kind: 'main' })
    s().undo()
    s().selectClip('c1')
    expect(s().selectedClipId).toBe('c1')
    s().redo()
    expect(s().project.mainTrackLocked).toBe(true)
    expect(s().selectedClipId).toBeNull()
  })
})

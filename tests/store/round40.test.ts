import { describe, expect, it } from 'vitest'
import { commitAsOwnStep, useProjectStore } from '@renderer/store/projectStore'
import { defaultTextStyle } from '@shared/textStyle'
import type { Project } from '@shared/types'
import { editTemplates } from '@shared/templates'

const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()
const asset = (id: string): Project['assets'][number] => ({
  id,
  filePath: `/m/${id}.mp4`,
  fileName: id,
  duration: 60,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  hasVideo: true
})

function setup(clips: Project['clips'], linkedTo: string, linkOffset: number, at: number): void {
  S.getState().loadProject(
    {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [asset('A'), asset('B'), asset('N')],
      clips,
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: [
        {
          id: 't',
          text: 'x',
          startTime: at,
          endTime: at + 1,
          style: defaultTextStyle(),
          linkedClipId: linkedTo,
          linkOffset
        }
      ],
      beatGrid: null
    } as unknown as Project,
    '/p.veproj'
  )
}

describe('第40回: 上書きで頭を削ったクリップに紐づくテロップ', () => {
  it('後ろのクリップの頭を削っても、テロップは素材の同じ所(同じ時刻)に残る', () => {
    setup(
      [
        { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1 },
        { id: 'c2', assetId: 'B', inPoint: 1, outPoint: 5, speed: 1 }
      ],
      'c2',
      3,
      7
    )
    st().overwriteClipAtTime('N', 0, 2, 3)
    expect(st().project.textOverlays[0].startTime).toBeCloseTo(7, 6)
  })

  it('1本のクリップの途中に上書きしても、後ろ半分に紐づくテロップは動かない', () => {
    setup([{ id: 'c1', assetId: 'A', inPoint: 0, outPoint: 10, speed: 1 }], 'c1', 6, 6)
    st().overwriteClipAtTime('N', 0, 2, 2)
    expect(st().project.textOverlays[0].startTime).toBeCloseTo(6, 6)
  })
})

describe('第40回: タイムラインのドラッグは1回ずつ履歴にする', () => {
  it('同じクリップを続けて(0.7 秒以内に)2回トリムしても、取り消しは1回ずつ', () => {
    setup([{ id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1 }], 'c1', 0, 0)
    commitAsOwnStep('trim-drop:c1', () => st().updateClipTrim('c1', 0, 3))
    commitAsOwnStep('trim-drop:c1', () => st().updateClipTrim('c1', 1, 3))
    expect(st().past).toHaveLength(2)
    st().undo()
    expect(st().project.clips[0]).toMatchObject({ inPoint: 0, outPoint: 3 })
  })
})

describe('第40回: 解析を待つ間に企画を替えたとき', () => {
  it('今の企画に無い素材のクリップは置かない(自動カット・仮編集・ショート)', () => {
    st().newProject()
    st().autoCutFromCandidates([{ assetId: 'nope', start: 0, end: 3 }], editTemplates[0])
    st().addRoughCutClips([{ assetId: 'nope', start: 0, end: 3 }])
    st().applyShortPlan([{ assetId: 'nope', start: 0, end: 3 }], [])
    expect(st().project.clips).toHaveLength(0)
    expect(st().past).toHaveLength(0)
  })

  it('名前を付けて新しい回を作ると、取り消しで既定の名前に戻らない', () => {
    st().newProject('第12回')
    expect(st().project.name).toBe('第12回')
    expect(st().past).toHaveLength(0)
  })
})

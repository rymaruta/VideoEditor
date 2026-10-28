import { describe, expect, it } from 'vitest'
import { restorePipelineFromProject } from '@renderer/lib/pipelineRestore'
import { normalizeAutoEdit } from '@shared/autoEdit'
import type { Project } from '@shared/types'

/**
 * 開き直した企画で、カメラの色合わせの工程が「待機 · 開き直した企画のため分かりません」と出ていた
 * (試し編集の回: 「合わせる必要のあるカメラはありませんでした」で済んでいたが、素材に色合わせの印が残らない)。
 * 済んだことを企画(`autoEdit.colorDone`)に覚えておき、開き直しても「完了」と出す。
 */

const project = (autoEdit?: unknown): Project =>
  ({
    id: 'p',
    name: '試し',
    aspectRatio: '16:9',
    assets: [
      {
        id: 'A',
        filePath: '/r/a.mp4',
        fileName: 'a.mp4',
        duration: 60,
        hasAudio: true,
        hasVideo: true
      },
      {
        id: 'B',
        filePath: '/r/b.mp4',
        fileName: 'b.mp4',
        duration: 60,
        hasAudio: true,
        hasVideo: true
      },
      {
        id: 'M',
        filePath: '/r/m.wav',
        fileName: 'm.wav',
        duration: 60,
        hasAudio: true,
        hasVideo: false
      }
    ],
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    multicam: {
      anchorSourceId: 'camA',
      sources: [
        { id: 'camA', name: 'カメラA', kind: 'camera' },
        { id: 'camB', name: 'カメラB', kind: 'camera' },
        { id: 'mic', name: 'マイク1', kind: 'mic' }
      ],
      files: [
        { assetId: 'A', sourceId: 'camA', start: 0, rate: 1, duration: 60 },
        { assetId: 'B', sourceId: 'camB', start: 0, rate: 1, duration: 60 },
        { assetId: 'M', sourceId: 'mic', start: 0, rate: 1, duration: 60 }
      ]
    },
    transcript: [
      {
        id: 'u1',
        assetId: 'M',
        speaker: 'マイク1',
        sourceStart: 1,
        sourceEnd: 4,
        text: 'こんにちは',
        words: [],
        overlap: false
      }
    ],
    ...(autoEdit ? { autoEdit } : {})
  }) as unknown as Project

const decisions = (extra: Record<string, unknown>): unknown =>
  normalizeAutoEdit(
    JSON.parse(
      JSON.stringify({
        scenes: [{ id: 's1', start: 0, end: 60 }],
        judgements: [{ sceneId: 's1', score: 50, kind: 'normal', reason: '' }],
        judgeSource: 'heuristic',
        keep: {},
        targetMinutes: 0,
        editNote: '',
        effects: [],
        effectChosen: [],
        ...extra
      })
    )
  )

describe('開き直した企画のカメラの色合わせ', () => {
  it('済んだ色合わせ(合わせる必要が無かった回)は、開き直しても「完了」と出す', () => {
    const autoEdit = decisions({ colorDone: '合わせる必要のあるカメラはありませんでした' })
    expect(autoEdit).toMatchObject({ colorDone: '合わせる必要のあるカメラはありませんでした' })
    const r = restorePipelineFromProject(project(autoEdit), 'location')
    expect(r?.steps.color).toEqual({
      state: 'done',
      percent: 100,
      note: '合わせる必要のあるカメラはありませんでした'
    })
  })

  it('済んだと覚えていない企画(前の版で保存したもの)は、今までどおり「分かりません」', () => {
    const r = restorePipelineFromProject(project(decisions({})), 'location')
    expect(r?.steps.color?.state).toBe('wait')
  })
})

import { describe, expect, it } from 'vitest'
import { buildReviewItems, openReviewCount } from '@renderer/lib/reviewItems'
import type { Project } from '@shared/types'

const project: Project = {
  id: 'p',
  name: 'p',
  aspectRatio: '16:9',
  assets: [],
  clips: [],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: []
}

describe('buildReviewItems', () => {
  it('同期・カメラの色・ノイズ除去・演出テロップ・書き出しの確認を1つの一覧にまとめ、時刻の順に並べる', () => {
    const items = buildReviewItems({
      project,
      syncIssues: [{ kind: 'unsynced', fileId: 'f1' }],
      fileLabel: (id) => `カメラB ${id}.MP4`,
      placedStart: () => undefined,
      telopReviews: [],
      colorIssues: [{ name: 'カメラB', verdict: 'shape' }],
      denoiseFailures: [{ fileName: 'PIN_02.WAV', error: '読めません' }],
      effects: [
        { id: 'e1', text: 'いや早すぎ!', confidence: 0.5 },
        { id: 'e2', text: '自動で置いた', confidence: 0.9 }
      ],
      effectChosen: ['e2'],
      qc: {
        path: '/out.mp4',
        state: 'done',
        percent: 100,
        measurement: null,
        issues: [
          {
            id: 'black-0',
            kind: 'black',
            severity: 'error',
            start: 12,
            end: 13,
            message: '黒い画面'
          }
        ]
      }
    })
    expect(items.map((i) => i.area)).toEqual(['export', 'sync', 'color', 'audio', 'effects'])
    expect(items[0].at).toBe(12)
    expect(items.find((i) => i.area === 'effects')?.text).toContain('1 件')
    expect(openReviewCount(items, [items[0].key])).toBe(4)
  })
})

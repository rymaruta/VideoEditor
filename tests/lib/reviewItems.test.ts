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

  it('テロップと顔の項目は、作り直し・文字の直しで時刻や文字が変わっても同じ鍵で同じテロップを指す', () => {
    const base = {
      syncIssues: [],
      fileLabel: (id: string) => id,
      placedStart: () => undefined,
      colorIssues: [],
      denoiseFailures: [],
      effects: [],
      effectChosen: [],
      qc: null
    }
    const telop = {
      id: 'o1',
      text: '直した文字',
      startTime: 7,
      endTime: 9,
      utteranceId: 'u1',
      utteranceChunk: 0
    } as Project['textOverlays'][number]
    const items = buildReviewItems({
      ...base,
      project: { ...project, textOverlays: [telop] },
      telopReviews: [{ startTime: 12, text: '元の文字', key: 'u:u1#0' }]
    })
    expect(items[0].key).toBe('telop-face:u:u1#0')
    expect(items[0].overlayId).toBe('o1')
    expect(items[0].at).toBe(7)
    // 人が消したテロップの項目は出さない
    const gone = buildReviewItems({
      ...base,
      project: { ...project, dismissedTelops: ['u:u1#0'] },
      telopReviews: [{ startTime: 12, text: '元の文字', key: 'u:u1#0' }]
    })
    expect(gone).toEqual([])
  })

  it('自信の低い演出テロップの項目は、どれかを選んでも鍵が変わらない', () => {
    const run = (chosen: string[]): string | undefined =>
      buildReviewItems({
        project,
        syncIssues: [],
        fileLabel: (id) => id,
        placedStart: () => undefined,
        telopReviews: [],
        colorIssues: [],
        denoiseFailures: [],
        effects: [
          { id: 'e1', text: 'a', confidence: 0.5 },
          { id: 'e2', text: 'b', confidence: 0.5 }
        ],
        effectChosen: chosen,
        qc: null
      }).find((i) => i.area === 'effects')?.key
    expect(run([])).toBe(run(['e1']))
  })
})

describe('ノイズ除去の項目の鍵', () => {
  it('同じ名前の録音が2本(別の録音機)あっても、項目は別々の鍵', () => {
    const items = buildReviewItems({
      project,
      syncIssues: [],
      fileLabel: (id: string) => id,
      placedStart: () => undefined,
      telopReviews: [],
      colorIssues: [],
      denoiseFailures: [
        { assetId: 'a1', fileName: 'ZOOM0001.WAV', error: '' },
        { assetId: 'a2', fileName: 'ZOOM0001.WAV', error: '' }
      ],
      effects: [],
      effectChosen: [],
      qc: null
    } as never)
    const keys = items.filter((i) => i.area === 'audio').map((i) => i.key)
    expect(new Set(keys).size).toBe(2)
  })
})

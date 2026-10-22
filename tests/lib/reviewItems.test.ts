import { describe, expect, it } from 'vitest'
import { buildReviewItems, openReviewCount } from '@renderer/lib/reviewItems'
import { utteranceToTelopChunks } from '@shared/telop/fromTranscript'
import { autoTelopKey, mergeManualTelops, rememberEditedTelops } from '@shared/telop/manual'
import { defaultTextStyle } from '@shared/textStyle'
import type { Project, TextOverlay } from '@shared/types'

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

describe('テロップと顔の項目(10/09 版の企画)', () => {
  // 10/09 版(c25f5af)で直した発話は、合わせた後の枚が元の部分を持たない(鍵は何枚目かだけ)。
  // 顔の配置は合わせる前の枚(範囲つきの鍵)で要確認を作るので、その鍵で置いた枚を探す
  const ws = [
    '今日は',
    'みんなで',
    'ラーメンを',
    '食べに',
    '横浜まで',
    '来ました',
    'すごく',
    '並んで'
  ]
  const u = {
    text: ws.join(''),
    words: ws.map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.5 })),
    sourceStart: 0,
    sourceEnd: 4
  }
  const style = defaultTextStyle()
  const mk = (withSource: boolean): Omit<TextOverlay, 'id'>[] =>
    utteranceToTelopChunks(u, { maxLineChars: 8 }).map((c, i) => ({
      text: c.text,
      startTime: c.sourceStart,
      endTime: c.sourceEnd,
      style,
      source: 'auto' as const,
      utteranceId: 'u1',
      utteranceChunk: i,
      ...(withSource
        ? { autoSource: { start: c.sourceStart, end: c.sourceEnd, text: c.text } }
        : {})
    }))
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

  it.each([
    ['10/09 版で直した企画', false],
    ['新しい企画', true]
  ])('%s: 要確認は置いた枚を指し、その枚を消すと要確認も消える', (_, fresh) => {
    // 前の企画: 0枚目を人が直した
    const old = mk(fresh).map((o, i) => ({ ...o, id: `old${i}` })) as TextOverlay[]
    old[0] = { ...old[0], text: `${old[0].text}!`, edited: true }
    const plan = mk(true)
    expect(plan.length).toBeGreaterThanOrEqual(2)
    const merged = mergeManualTelops(old, plan, new Set(), rememberEditedTelops(old, undefined))
    const overlays = merged.map((o, i) => ({ ...o, id: `o${i}` })) as TextOverlay[]
    const target = overlays.find((o) => o.utteranceChunk === 1)!
    target.text = '人が直した1枚目'
    const telopReviews = [
      { startTime: plan[1].startTime, text: plan[1].text, key: autoTelopKey(plan[1]) }
    ]
    const items = buildReviewItems({
      ...base,
      project: { ...project, textOverlays: overlays },
      telopReviews
    })
    expect(items).toHaveLength(1)
    expect(items[0].overlayId).toBe(target.id)
    expect(items[0].text).toContain('人が直した1枚目')
    // その枚を消す(消した印は置いた枚の鍵)
    const gone = buildReviewItems({
      ...base,
      project: {
        ...project,
        textOverlays: overlays.filter((o) => o !== target),
        dismissedTelops: [autoTelopKey(target)!]
      },
      telopReviews
    })
    expect(gone).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import {
  cameraLabel,
  decisionConclusion,
  reasonStats,
  type ClipDecision
} from '../../src/renderer/src/lib/clipDecision'
import { dockRectFrom } from '../../src/renderer/src/lib/programDock'
import { SPEAKER_PALETTE, speakerOrderIndex, speakersInOrder } from '../../src/shared/speaker'

/** 確認の画面の小物: AI の判断の結論と数の表、カメラの呼び名、話者の色の順、重ねたプログラムの切り取り */

const decision = (over: Partial<ClipDecision> = {}): ClipDecision => ({
  scenes: [],
  camera: null,
  manualAngle: false,
  manualAdded: false,
  locked: false,
  judgeSource: 'heuristic',
  ...over
})

const scene = (
  kind: 'highlight' | 'normal' | 'unneeded',
  reason: string,
  keep?: boolean
): ClipDecision['scenes'][number] => ({
  id: 's',
  kind,
  score: 80,
  reason,
  keep,
  overlap: 10
})

describe('AI の判断の結論と数の表', () => {
  it('簡易の点数の理由は、名前と値の表に分ける(ふつうの文は残りの文)', () => {
    expect(reasonStats('発話 49% · 掛け合い 7回/分 · 声の重なり 1 · 感嘆・疑問 2')).toEqual({
      stats: [
        ['発話', '49%'],
        ['掛け合い', '7回/分'],
        ['声の重なり', '1'],
        ['感嘆・疑問', '2']
      ],
      rest: []
    })
    expect(reasonStats('会話がほとんど無い · 発話 5%')).toEqual({
      stats: [['発話', '5%']],
      rest: ['会話がほとんど無い']
    })
    expect(reasonStats('頂上に着いた瞬間の歓声と景色。')).toEqual({
      stats: [],
      rest: ['頂上に着いた瞬間の歓声と景色。']
    })
    expect(reasonStats(null)).toEqual({ stats: [], rest: [] })
  })

  it('1 行目は結論の文: 掛け合いが多い見どころ・笑い・普通・手で決めた場面', () => {
    expect(
      decisionConclusion(decision({ scenes: [scene('highlight', '発話 60% · 掛け合い 8回/分')] }))
    ).toBe('掛け合いが多く盛り上がる場面なので残しました')
    expect(
      decisionConclusion(decision({ scenes: [scene('highlight', '発話 60% · 笑い 2')] }))
    ).toBe('笑いや歓声が起きた見どころの場面なので残しました')
    expect(decisionConclusion(decision({ scenes: [scene('normal', '発話 40%')] }))).toMatch(
      /^普通の場面として残しました/
    )
    expect(decisionConclusion(decision({ scenes: [scene('normal', '', true)] }))).toBe(
      '画面で「残す」に決めた場面なので残しました'
    )
    expect(decisionConclusion(decision())).toBe('この所に重なる場面の判定はありません')
  })

  it('カメラは「カメラ C(手元)」の形(名前がもう「カメラ」で始まれば足さない)', () => {
    expect(cameraLabel('C', '手元')).toBe('カメラ C(手元)')
    expect(cameraLabel('カメラ1', 'ホスト')).toBe('カメラ1(ホスト)')
    expect(cameraLabel('B')).toBe('カメラ B')
  })
})

describe('話者の色(出てきた順)', () => {
  it('最初の 2 人は #5cc1b3 と #e08a9a、3 人目は琥珀から離れた珊瑚色', () => {
    expect(SPEAKER_PALETTE.slice(0, 3)).toEqual(['#5cc1b3', '#e08a9a', '#d9785f'])
    const order = speakersInOrder([
      { speaker: 'トム' },
      { speaker: ' セリア ' },
      { speaker: 'トム' },
      {}
    ])
    expect(order).toEqual(['トム', 'セリア'])
    expect(speakerOrderIndex(order, 'トム')).toBe(0)
    expect(speakerOrderIndex(order, 'セリア')).toBe(1)
    expect(speakerOrderIndex(order, undefined)).toBeNull()
    // 9 人目からはまた 0 から
    const many = Array.from({ length: 10 }, (_, i) => `話者${i}`)
    expect(speakerOrderIndex(many, '話者8')).toBe(0)
  })
})

describe('【監査 2026-10】重ねたプログラムは、右の列の外へはみ出す所を切り取る', () => {
  it('列の中に収まっていれば切らない', () => {
    expect(
      dockRectFrom({ left: 10, top: 100, width: 432, height: 243 }, { top: 84, bottom: 700 })
    ).toEqual({ left: 10, top: 100, width: 432, height: 243, clipTop: 0, clipBottom: 0 })
  })
  it('上へ送ってはみ出した分・下へはみ出した分を切る(全部はみ出したら高さぶん)', () => {
    expect(
      dockRectFrom({ left: 0, top: 40, width: 432, height: 243 }, { top: 84, bottom: 200 })
    ).toMatchObject({ clipTop: 44, clipBottom: 83 })
    expect(
      dockRectFrom({ left: 0, top: -400, width: 432, height: 243 }, { top: 84, bottom: 600 })
    ).toMatchObject({ clipTop: 243 })
  })
})

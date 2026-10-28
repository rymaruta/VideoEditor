import { describe, expect, it } from 'vitest'
import {
  selectScenes,
  trailingFragment,
  type Scene,
  type SceneJudgement
} from '../../src/shared/structure/scenes'

/**
 * 第4回の直し(N4)の監査の指摘 1: 言いかけの切れ端を落とす決まり(fragment)が、長さの目標と関係なく見どころ・
 * 番組の終わりの場面まで落としていた(前の場面が「不要」で「それで我々は」で終わり、最後が 90 点・11.5 秒の
 * 見どころ「ありがとうございました」でも落ちた)。目標があり、見どころでも番組の頭・終わりでもなく、点数が
 * 残した場面の中で低い方のときだけにする。手で後ろを残したら、それが最後
 */
const mk = (id: string, start: number, end: number, text: string): Scene => ({
  id,
  start,
  end,
  speech: end - start,
  lines: [{ id: `${id}-l`, start, end, text, overlap: false, speaker: 'マイク1' }]
})
const j = (
  sceneId: string,
  score: number,
  kind: SceneJudgement['kind'] = 'normal'
): SceneJudgement => ({ sceneId, score, kind, reason: '' })

describe('指摘の再現: 番組の終わりの見どころ「ありがとうございました」', () => {
  const scenes = [
    mk('s1', 0, 100, '始めます'),
    mk('s2', 100, 190, 'とても大事だと思っております'),
    mk('s3', 190, 280, 'それで我々は'),
    mk('s4', 280, 291.5, 'ありがとうございました')
  ]
  const judgements = [j('s1', 80), j('s2', 70), j('s3', 20, 'unneeded'), j('s4', 90, 'highlight')]

  it('目標なし(Infinity)・目標あり・点数の下限のどれでも落とさない', () => {
    expect(selectScenes(scenes, judgements, Infinity).kept).toEqual(['s1', 's2', 's4'])
    expect(selectScenes(scenes, judgements, 400).kept).toEqual(['s1', 's2', 's4'])
    expect(selectScenes(scenes, judgements, Infinity, undefined, 50).kept).toEqual([
      's1',
      's2',
      's4'
    ])
    expect(trailingFragment(scenes, judgements, new Set(['s1', 's2', 's4']), 400)).toBeNull()
  })
})

describe('trailingFragment', () => {
  // 第4回の作り: 文の途中から始まる 9 秒の場面が、前を落として最後に残る(後ろに番組の続きがある)
  const scenes = [
    mk('s1', 0, 100, '始めます'),
    mk('s2', 100, 190, 'とても大事だと思っております'),
    mk('s3', 190, 280, 'あとやはり我々は'),
    mk('s4', 280, 289, '一緒に良いところも悪いところも頑張っていこうという形で'),
    mk('s5', 289, 400, '政府の政策も活用されてきましたか')
  ]
  const judgements = [j('s1', 85), j('s2', 80), j('s3', 75), j('s4', 60), j('s5', 55)]
  const kept = new Set(['s1', 's2', 's4'])

  it('目標があり、見どころでも番組の頭・終わりでもない、点数の低い切れ端だけ落とす', () => {
    expect(trailingFragment(scenes, judgements, kept, 200)).toBe('s4')
    // 目標なし
    expect(trailingFragment(scenes, judgements, kept, 0)).toBeNull()
    expect(trailingFragment(scenes, judgements, kept, Infinity)).toBeNull()
    // 見どころ
    const hl = judgements.map((x) =>
      x.sceneId === 's4' ? { ...x, kind: 'highlight' as const } : x
    )
    expect(trailingFragment(scenes, hl, kept, 200)).toBeNull()
    // 点数が残した場面の中で高い方
    const high = judgements.map((x) => (x.sceneId === 's4' ? { ...x, score: 95 } : x))
    expect(trailingFragment(scenes, high, kept, 200)).toBeNull()
    // 番組の終わりの場面
    expect(trailingFragment(scenes.slice(0, 4), judgements, kept, 200)).toBeNull()
    // 手で残した
    expect(trailingFragment(scenes, judgements, kept, 200, new Set(['s4']))).toBeNull()
  })

  it('手で後ろの場面を残したら、それが最後(切れ端は最後ではない)', () => {
    expect(trailingFragment(scenes, judgements, new Set([...kept, 's5']), 200)).toBeNull()
  })

  it('selectScenes(手で決める前)では落とさない(手の残すを当てた後で決める)', () => {
    const r = selectScenes(scenes, judgements, 200)
    expect(r.dropped.some((d) => d.by === 'fragment')).toBe(false)
  })
})

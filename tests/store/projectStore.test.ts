import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '@renderer/store/projectStore'
import type { Project, TextOverlay } from '@shared/types'
import { defaultTextStyle } from '@shared/textStyle'
import type { PlacedSound } from '@shared/finish/sound'
import { audioClipDuration } from '@renderer/lib/timelineMath'
import { seeded } from '../helpers/boundary'

const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()

/** 分離音声・追従テロップ・PiP・BGM を全部持った土台 */
function baseProject(): Project {
  return {
    id: 'p',
    name: 'inv',
    aspectRatio: '16:9',
    assets: [
      {
        id: 'A',
        filePath: '/x/a.mp4',
        fileName: 'a.mp4',
        duration: 10,
        width: 1280,
        height: 720,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      },
      {
        id: 'B',
        filePath: '/x/b.mp4',
        fileName: 'b.mp4',
        duration: 8,
        width: 1280,
        height: 720,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      },
      {
        id: 'M',
        filePath: '/x/m.m4a',
        fileName: 'm.m4a',
        duration: 20,
        width: 0,
        height: 0,
        fps: 0,
        hasAudio: true,
        hasVideo: false
      }
    ],
    clips: [
      { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1, audioDetached: true },
      { id: 'c2', assetId: 'B', inPoint: 1, outPoint: 5, speed: 1 },
      { id: 'c3', assetId: 'A', inPoint: 2, outPoint: 6, speed: 1 }
    ],
    audioTracks: [
      {
        id: 't1',
        name: 'BGM',
        volume: 1,
        muted: false,
        kind: 'bgm',
        duckingEnabled: false,
        clips: [
          { id: 'a1', assetId: 'M', startTime: 6, inPoint: 0, outPoint: 5, volume: 1, speed: 1 }
        ]
      },
      {
        id: 't2',
        name: '分離音声',
        volume: 1,
        muted: false,
        kind: 'voice',
        duckingEnabled: false,
        clips: [
          {
            id: 'a2',
            assetId: 'A',
            startTime: 0,
            inPoint: 0,
            outPoint: 4,
            volume: 1,
            speed: 1,
            linkedClipId: 'c1'
          }
        ]
      }
    ],
    videoOverlayTracks: [
      {
        id: 'v1',
        name: 'PiP',
        hidden: false,
        position: 'top-right',
        scale: 0.3,
        clips: [{ id: 'p1', assetId: 'B', startTime: 2, inPoint: 0, outPoint: 3 }]
      }
    ],
    textOverlays: [
      {
        id: 'o1',
        text: 'あ',
        startTime: 1,
        endTime: 3,
        style: {},
        source: 'manual',
        linkedClipId: 'c1',
        linkOffset: 1
      },
      { id: 'o2', text: 'い', startTime: 5, endTime: 7, style: {}, source: 'manual' }
    ],
    beatGrid: null
  } as unknown as Project
}

/** ミラー(購読)が収束した状態から始める */
function reset(): void {
  S.setState({
    project: baseProject(),
    past: [],
    future: [],
    selectedClipId: null,
    multiSelectedClipIds: [],
    clipboardClips: [],
    missingAssetPaths: [],
    missingAssetIds: []
  })
  S.setState({ project: { ...S.getState().project } })
}

const snap = (): string => JSON.stringify(st().project)

/**
 * **プロジェクトが常に満たしていなければならないこと。**
 * どれか1つでも破れたら、画面のどこかで「見えないのに存在する」物が生まれる。
 */
function brokenInvariant(p: Project): string | null {
  const clipIds = p.clips.map((c) => c.id)
  if (new Set(clipIds).size !== clipIds.length) return '本編クリップIDが重複'

  const audioIds = p.audioTracks.flatMap((t) => t.clips.map((c) => c.id))
  if (new Set(audioIds).size !== audioIds.length) return '音声クリップIDが重複'

  const pipIds = p.videoOverlayTracks.flatMap((t) => t.clips.map((c) => c.id))
  if (new Set(pipIds).size !== pipIds.length) return 'PiPクリップIDが重複'

  const overlayIds = p.textOverlays.map((o) => o.id)
  if (new Set(overlayIds).size !== overlayIds.length) return 'テロップIDが重複'

  const ids = new Set(clipIds)
  if (p.audioTracks.flatMap((t) => t.clips).some((c) => c.linkedClipId && !ids.has(c.linkedClipId)))
    return '音声の linkedClipId が居ないクリップを指す'
  if (p.textOverlays.some((o) => o.linkedClipId && !ids.has(o.linkedClipId)))
    return 'テロップの linkedClipId が居ないクリップを指す'

  const assetIds = new Set(p.assets.map((a) => a.id))
  const dur = new Map(p.assets.map((a) => [a.id, a.duration]))

  for (const c of p.clips) {
    if (!assetIds.has(c.assetId)) return `本編クリップ ${c.id} が居ない素材を指す`
    const d = dur.get(c.assetId)!
    if (!(c.inPoint >= 0 && c.outPoint > c.inPoint && c.outPoint <= d + 1e-9))
      return `本編クリップ ${c.id} の範囲が不正 in=${c.inPoint} out=${c.outPoint} 素材=${d}`
  }
  for (const t of p.audioTracks) {
    for (const c of t.clips) {
      if (!assetIds.has(c.assetId)) return `音声クリップ ${c.id} が居ない素材を指す`
      const d = dur.get(c.assetId)!
      if (!(c.startTime >= 0 && c.inPoint >= 0 && c.outPoint > c.inPoint && c.outPoint <= d + 1e-9))
        return `音声クリップ ${c.id} が不正 s=${c.startTime} in=${c.inPoint} out=${c.outPoint} 素材=${d}`
      if (!Number.isFinite(audioClipDuration(c))) return `音声クリップ ${c.id} の長さが有限でない`
    }
  }
  for (const t of p.videoOverlayTracks) {
    for (const c of t.clips) {
      if (!assetIds.has(c.assetId)) return `PiP ${c.id} が居ない素材を指す`
      const d = dur.get(c.assetId)!
      if (!(c.startTime >= 0 && c.inPoint >= 0 && c.outPoint > c.inPoint && c.outPoint <= d + 1e-9))
        return `PiP ${c.id} が不正 s=${c.startTime} in=${c.inPoint} out=${c.outPoint} 素材=${d}`
    }
  }
  if (p.textOverlays.some((o) => !(o.startTime >= 0 && o.endTime >= o.startTime)))
    return 'テロップの範囲が不正'
  return null
}

/** 1操作＝1アクション。**契約どおりの引数**しか渡さない(壊れた入力の話は別のテスト)。 */
const actions: { name: string; run: () => void }[] = [
  { name: 'updateClipTrim', run: () => st().updateClipTrim('c2', 2, 4) },
  { name: 'updateClipSpeed', run: () => st().updateClipSpeed('c2', 2) },
  { name: 'updateClipsSpeed(複数)', run: () => st().updateClipsSpeed(['c1', 'c3'], 0.5) },
  { name: 'updateClipsColorLabel', run: () => st().updateClipsColorLabel(['c1'], 'red') },
  {
    name: 'updateClipTransition',
    run: () => st().updateClipTransition('c2', { type: 'crossfade', duration: 1 })
  },
  { name: 'updateClipCrop', run: () => st().updateClipCrop('c1', true, { x: 0.4, y: 0.6 }) },
  { name: 'updateClipBlurBackground', run: () => st().updateClipBlurBackground('c1', true) },
  { name: 'splitClipAtTime(分離済み)', run: () => st().splitClipAtTime('c1', 2) },
  { name: 'splitClipAtTime(ふつう)', run: () => st().splitClipAtTime('c2', 6) },
  { name: 'removeClip(分離済み)', run: () => st().removeClip('c1') },
  { name: 'removeClips(複数)', run: () => st().removeClips(['c1', 'c2']) },
  { name: 'duplicateClips', run: () => st().duplicateClips(['c1']) },
  { name: 'moveClip(左)', run: () => st().moveClip('c3', 'left') },
  { name: 'moveClipToIndex(末尾へ)', run: () => st().moveClipToIndex('c1', 3) },
  { name: 'rollTrim', run: () => st().rollTrim('c1', 'c2', 0.5) },
  { name: 'detachClipAudio', run: () => st().detachClipAudio('c2') },
  { name: 'reattachClipAudio', run: () => st().reattachClipAudio('c1') },
  { name: 'setAspectRatio', run: () => st().setAspectRatio('9:16') },
  {
    name: 'addTextOverlay',
    run: () =>
      st().addTextOverlay({
        text: 'う',
        startTime: 2,
        endTime: 4,
        style: {},
        source: 'manual'
      } as never)
  },
  { name: 'updateTextOverlay(文言)', run: () => st().updateTextOverlay('o1', { text: 'かき' }) },
  {
    name: 'updateTextOverlay(位置)',
    run: () => st().updateTextOverlay('o1', { startTime: 1.5, endTime: 3.5 })
  },
  { name: 'removeTextOverlay', run: () => st().removeTextOverlay('o2') },
  { name: 'shiftAllTextOverlays', run: () => st().shiftAllTextOverlays(1.5) },
  { name: 'setTextOverlayLink(付ける)', run: () => st().setTextOverlayLink('o2', 'c2') },
  { name: 'setTextOverlayLink(外す)', run: () => st().setTextOverlayLink('o1', null) },
  { name: 'addAudioTrack', run: () => st().addAudioTrack('新トラック') },
  { name: 'removeAudioTrack(分離音声ごと)', run: () => st().removeAudioTrack('t2') },
  { name: 'setAudioTrackVolume', run: () => st().setAudioTrackVolume('t1', 0.4) },
  { name: 'toggleAudioTrackMute', run: () => st().toggleAudioTrackMute('t1') },
  { name: 'toggleAudioTrackDucking', run: () => st().toggleAudioTrackDucking('t1') },
  { name: 'addClipToAudioTrack', run: () => st().addClipToAudioTrack('t1', 'M') },
  { name: 'updateAudioClipStart', run: () => st().updateAudioClipStart('t1', 'a1', 3) },
  { name: 'updateAudioClipTrim', run: () => st().updateAudioClipTrim('t1', 'a1', 1, 4) },
  {
    name: 'updateAudioClipStartAndTrim',
    run: () => st().updateAudioClipStartAndTrim('t1', 'a1', 2, 1, 4)
  },
  { name: 'updateAudioClipVolume', run: () => st().updateAudioClipVolume('t1', 'a1', 0.3) },
  { name: 'updateAudioClipFade', run: () => st().updateAudioClipFade('t1', 'a1', 0.5, 0.5) },
  { name: 'splitAudioClipAtTime', run: () => st().splitAudioClipAtTime('t1', 'a1', 8) },
  { name: 'removeAudioClip(分離音声)', run: () => st().removeAudioClip('t2', 'a2') },
  { name: 'moveAudioClipToTrack', run: () => st().moveAudioClipToTrack('t2', 'a2', 't1', 0) },
  { name: 'unlinkAudioClip', run: () => st().unlinkAudioClip('t2', 'a2') },
  { name: 'swapAudioClipAsset', run: () => st().swapAudioClipAsset('t1', 'a1', 'M', 6) },
  { name: 'addVideoOverlayTrack', run: () => st().addVideoOverlayTrack('PiP2') },
  { name: 'removeVideoOverlayTrack', run: () => st().removeVideoOverlayTrack('v1') },
  { name: 'setVideoOverlayTrackScale', run: () => st().setVideoOverlayTrackScale('v1', 0.5) },
  {
    name: 'setVideoOverlayTrackPosition',
    run: () => st().setVideoOverlayTrackPosition('v1', 'bottom-left')
  },
  { name: 'toggleVideoOverlayTrackHidden', run: () => st().toggleVideoOverlayTrackHidden('v1') },
  {
    name: 'updateVideoOverlayClipStart',
    run: () => st().updateVideoOverlayClipStart('v1', 'p1', 4)
  },
  {
    name: 'updateVideoOverlayClipTrim',
    run: () => st().updateVideoOverlayClipTrim('v1', 'p1', 1, 2)
  },
  {
    name: 'splitVideoOverlayClipAtTime',
    run: () => st().splitVideoOverlayClipAtTime('v1', 'p1', 3)
  },
  { name: 'removeVideoOverlayClip', run: () => st().removeVideoOverlayClip('v1', 'p1') },
  {
    name: 'swapVideoOverlayClipAsset',
    run: () => st().swapVideoOverlayClipAsset('v1', 'p1', 'A', 10)
  },
  { name: 'setProjectName', run: () => st().setProjectName('あたらしい名前') },
  {
    name: 'setBeatGrid',
    run: () => st().setBeatGrid({ bpm: 120, offset: 0, enabled: true } as never)
  },
  { name: 'removeAsset', run: () => st().removeAsset('B') },
  {
    name: 'replaceClipRange',
    run: () =>
      st().replaceClipRange('c1', [
        { id: 'n1', assetId: 'A', inPoint: 0, outPoint: 1, speed: 1 },
        { id: 'n2', assetId: 'A', inPoint: 2, outPoint: 4, speed: 1 }
      ] as never)
  },
  {
    name: 'copy → paste',
    run: () => {
      st().selectClip('c2')
      st().copySelectedClip()
      st().pasteClip()
    }
  }
]

describe('ストアの不変条件 — 1アクションずつ', () => {
  beforeEach(reset)

  it('土台そのものが不変条件を満たしている', () => {
    expect(brokenInvariant(st().project)).toBeNull()
  })

  for (const a of actions) {
    it(`${a.name}: 実行後も不変条件が保たれる`, () => {
      a.run()
      expect(brokenInvariant(st().project)).toBeNull()
    })
  }
})

describe('履歴 — 1操作 = Undo 1件', () => {
  beforeEach(reset)

  for (const a of actions) {
    it(`${a.name}: 履歴 +1、取り消しで完全に戻り、やり直しで完全に進む`, () => {
      const before = snap()
      const pastBefore = st().past.length
      a.run()
      const after = snap()
      if (after === before) {
        // 企画が変わらない操作は履歴も積まない(空の取り消しを作らない)
        expect(st().past.length).toBe(pastBefore)
        return
      }
      expect(st().past.length - pastBefore, '1操作で積まれた履歴の数').toBe(1)
      st().undo()
      expect(snap(), '取り消しで元に戻る').toBe(before)
      st().redo()
      expect(snap(), 'やり直しで操作後に戻る').toBe(after)
    })
  }

  it('取り消しは未保存の印を立てる(保存ボタンが死なないように)', () => {
    st().updateClipTrim('c2', 2, 4)
    S.setState({ isDirty: false })
    st().undo()
    expect(st().isDirty).toBe(true)
  })

  it('同じ値を入れ直しただけなら履歴も未保存の印も動かない', () => {
    const pastBefore = st().past.length
    st().setAspectRatio('16:9') // すでに 16:9
    expect(st().past.length).toBe(pastBefore)
  })

  it('取り消し → 本物の編集、で履歴を積み損ねない', () => {
    // まとめ判定の目印を落とし損ねると、この直後の編集が履歴を積まずに消える
    st().updateClipTrim('c2', 2, 4)
    st().undo()
    const pastBefore = st().past.length
    st().updateClipTrim('c2', 1.5, 3)
    expect(st().past.length - pastBefore).toBe(1)
    st().undo()
    expect(st().project.clips.find((c) => c.id === 'c2')!.inPoint).toBe(1)
  })
})

describe('分離音声のリンク — 消えた相手を指し続けない', () => {
  beforeEach(reset)

  it('本編クリップを消すと、紐づいた音声も一緒に消える', () => {
    st().removeClip('c1')
    const linked = st()
      .project.audioTracks.flatMap((t) => t.clips)
      .filter((c) => c.linkedClipId)
    expect(linked).toHaveLength(0)
  })

  it('紐づいた音声を消すと、本編クリップのミュートが解ける', () => {
    st().removeAudioClip('t2', 'a2')
    expect(st().project.clips.find((c) => c.id === 'c1')!.audioDetached).toBe(false)
  })

  it('音声トラックごと消しても同じ', () => {
    st().removeAudioTrack('t2')
    expect(st().project.clips.find((c) => c.id === 'c1')!.audioDetached).toBe(false)
  })

  it('リンクだけ外して音声が残るなら、本編はミュートのまま(音が二重にならない)', () => {
    st().unlinkAudioClip('t2', 'a2')
    expect(st().project.clips.find((c) => c.id === 'c1')!.audioDetached).toBe(true)
    expect(st().project.audioTracks.find((t) => t.id === 't2')!.clips).toHaveLength(1)
  })

  it('本編を分割すると、紐づいた音声も分割されて後半に付く', () => {
    st().splitClipAtTime('c1', 2)
    const clips = st().project.clips
    const second = clips[1]
    const linked = st()
      .project.audioTracks.flatMap((t) => t.clips)
      .filter((c) => c.linkedClipId)
    expect(linked.length).toBeGreaterThanOrEqual(2)
    expect(linked.some((c) => c.linkedClipId === second.id)).toBe(true)
  })

  it('本編を並べ替えると、紐づいた音声の位置も追従する', () => {
    const before = st()
      .project.audioTracks.flatMap((t) => t.clips)
      .find((c) => c.linkedClipId)!
    expect(before.startTime).toBe(0)
    st().moveClipToIndex('c1', 3)
    const after = st()
      .project.audioTracks.flatMap((t) => t.clips)
      .find((c) => c.linkedClipId)!
    expect(after.startTime).toBeGreaterThan(0)
    const source = st().project.clips.find((c) => c.id === after.linkedClipId)
    expect(source).toBeDefined()
  })
})

describe('【既知の穴】ストアはテロップの前後関係を守っていない', () => {
  beforeEach(reset)

  /**
   * `updateTextOverlay` は受け取った値をそのまま入れるので、**開始だけを終了より
   * 後ろへ**渡すと逆転したテロップができる。画面の3つの入口(数値欄・タイムラインの
   * つまみ・プレビューのドラッグ)はどれも手前でクランプしているので**いまは届かない**が、
   * 規則は「書き込み先に置く」が正しい(2026-09-10 に足したチェックリスト項目)。
   * BACKLOG の候補に積んである。**直したらこのテストが落ちる**ので、
   * そのとき期待値を「クランプされる」に書き換えること。
   */
  it('開始だけを終了より後ろへ渡すと、逆転したまま保存される', () => {
    st().updateTextOverlay('o1', { startTime: 99 })
    const o = st().project.textOverlays.find((x) => x.id === 'o1')!
    expect(o.startTime).toBeGreaterThan(o.endTime)
  })

  it('負の開始も、そのまま入る', () => {
    st().updateTextOverlay('o2', { startTime: -4 })
    expect(st().project.textOverlays.find((x) => x.id === 'o2')!.startTime).toBe(-4)
  })
})

describe('クリップボード — コピーしたあとに素材が消えても壊れない', () => {
  beforeEach(reset)

  it('素材が消えたクリップは貼らない(見えないのに書き出しだけ失敗するのを防ぐ)', () => {
    st().selectClip('c2')
    st().copySelectedClip()
    st().removeAsset('B')
    const before = st().project.clips.length
    st().pasteClip()
    expect(st().project.clips.length).toBe(before)
    expect(brokenInvariant(st().project)).toBeNull()
  })

  it('素材が戻れば貼れる(クリップボードは捨てない)', () => {
    st().selectClip('c2')
    st().copySelectedClip()
    st().removeAsset('B')
    st().undo()
    const before = st().project.clips.length
    st().pasteClip()
    expect(st().project.clips.length).toBe(before + 1)
  })
})

describe('連続操作 — ランダムな手順でも壊れない', () => {
  const rnd = seeded(20260910)
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]
  const num = (lo: number, hi: number): number => lo + rnd() * (hi - lo)
  const anyClip = (): string | null =>
    st().project.clips.length ? pick(st().project.clips).id : null
  const anyAudio = (): { t: string; c: string } | null => {
    const pairs = st().project.audioTracks.flatMap((t) =>
      t.clips.map((c) => ({ t: t.id, c: c.id }))
    )
    return pairs.length ? pick(pairs) : null
  }
  const anyPip = (): { t: string; c: string } | null => {
    const pairs = st().project.videoOverlayTracks.flatMap((t) =>
      t.clips.map((c) => ({ t: t.id, c: c.id }))
    )
    return pairs.length ? pick(pairs) : null
  }

  const ops: { name: string; run: () => void }[] = [
    {
      name: 'トリム',
      run: () => {
        const id = anyClip()
        if (id) st().updateClipTrim(id, num(0, 3), num(3.5, 7))
      }
    },
    {
      name: '速度',
      run: () => {
        const id = anyClip()
        if (id) st().updateClipSpeed(id, pick([0.25, 0.5, 1, 2, 4]))
      }
    },
    {
      name: '分割',
      run: () => {
        const id = anyClip()
        if (id) st().splitClipAtTime(id, num(0, 12))
      }
    },
    {
      name: '削除',
      run: () => {
        const id = anyClip()
        if (id) st().removeClip(id)
      }
    },
    {
      name: '複製',
      run: () => {
        const id = anyClip()
        if (id) st().duplicateClips([id])
      }
    },
    {
      name: '並べ替え',
      run: () => {
        const id = anyClip()
        if (id) st().moveClipToIndex(id, Math.floor(num(0, 5)))
      }
    },
    {
      name: '左右へ移動',
      run: () => {
        const id = anyClip()
        if (id) st().moveClip(id, pick(['left', 'right'] as const))
      }
    },
    {
      name: '音声分離',
      run: () => {
        const id = anyClip()
        if (id) st().detachClipAudio(id)
      }
    },
    {
      name: '音声を戻す',
      run: () => {
        const id = anyClip()
        if (id) st().reattachClipAudio(id)
      }
    },
    {
      name: 'ロールトリム',
      run: () => {
        const c = st().project.clips
        if (c.length >= 2) {
          const i = Math.floor(num(0, c.length - 1))
          st().rollTrim(c[i].id, c[i + 1].id, num(-1, 1))
        }
      }
    },
    {
      name: '音声を動かす',
      run: () => {
        const a = anyAudio()
        if (a) st().updateAudioClipStart(a.t, a.c, num(0, 12))
      }
    },
    {
      name: '音声をトリム',
      run: () => {
        const a = anyAudio()
        if (a) st().updateAudioClipTrim(a.t, a.c, num(0, 2), num(2.5, 6))
      }
    },
    {
      name: '音声を割る',
      run: () => {
        const a = anyAudio()
        if (a) st().splitAudioClipAtTime(a.t, a.c, num(0, 12))
      }
    },
    {
      name: '音声を消す',
      run: () => {
        const a = anyAudio()
        if (a) st().removeAudioClip(a.t, a.c)
      }
    },
    {
      name: '音声を別トラックへ',
      run: () => {
        const a = anyAudio()
        if (a) {
          const other = st().project.audioTracks.find((t) => t.id !== a.t)
          if (other) st().moveAudioClipToTrack(a.t, a.c, other.id, num(0, 10))
        }
      }
    },
    { name: '音声トラックを足す', run: () => st().addAudioTrack('T' + Math.floor(num(0, 999))) },
    {
      name: '音声トラックを消す',
      run: () => {
        const t = st().project.audioTracks
        if (t.length) st().removeAudioTrack(pick(t).id)
      }
    },
    {
      name: '音声素材を足す',
      run: () => {
        const t = st().project.audioTracks
        if (t.length) st().addClipToAudioTrack(pick(t).id, 'M')
      }
    },
    {
      name: 'PiPを動かす',
      run: () => {
        const p = anyPip()
        if (p) st().updateVideoOverlayClipStart(p.t, p.c, num(0, 12))
      }
    },
    {
      name: 'PiPをトリム',
      run: () => {
        const p = anyPip()
        if (p) st().updateVideoOverlayClipTrim(p.t, p.c, num(0, 2), num(2.5, 7))
      }
    },
    {
      name: 'PiPを割る',
      run: () => {
        const p = anyPip()
        if (p) st().splitVideoOverlayClipAtTime(p.t, p.c, num(0, 12))
      }
    },
    {
      name: 'PiPを消す',
      run: () => {
        const p = anyPip()
        if (p) st().removeVideoOverlayClip(p.t, p.c)
      }
    },
    {
      name: 'テロップを足す',
      run: () => {
        const t = num(0, 10)
        st().addTextOverlay({
          text: 'て',
          startTime: t,
          endTime: t + num(0.5, 3),
          style: {},
          source: 'manual'
        } as never)
      }
    },
    // 画面の操作はどれも**尺を保ったまま**動かす(つまみは別アクション)。
    // 開始だけを終了より後ろへ飛ばす経路はUIに無い——下の「既知の穴」を参照。
    {
      name: 'テロップを動かす',
      run: () => {
        const o = st().project.textOverlays
        if (!o.length) return
        const t = pick(o)
        const d = t.endTime - t.startTime
        const s2 = num(0, 12)
        st().updateTextOverlay(t.id, { startTime: s2, endTime: s2 + d })
      }
    },
    { name: 'テロップを全部ずらす', run: () => st().shiftAllTextOverlays(num(-5, 5)) },
    {
      name: 'テロップを消す',
      run: () => {
        const o = st().project.textOverlays
        if (o.length) st().removeTextOverlay(pick(o).id)
      }
    },
    {
      name: '素材を消す',
      run: () => {
        const a = st().project.assets
        if (a.length) st().removeAsset(pick(a).id)
      }
    },
    {
      name: 'コピー→貼り付け',
      run: () => {
        const id = anyClip()
        if (id) {
          st().selectClip(id)
          st().copySelectedClip()
          st().pasteClip()
        }
      }
    },
    { name: '縦横比', run: () => st().setAspectRatio(pick(['16:9', '9:16'] as const)) }
  ]

  it('200ラウンド × 30手のあいだ、一度も不変条件を破らない', () => {
    for (let r = 0; r < 200; r++) {
      reset()
      const trail: string[] = []
      for (let s = 0; s < 30; s++) {
        const op = pick(ops)
        trail.push(op.name)
        op.run()
        const bad = brokenInvariant(st().project)
        expect(bad, `手順: ${trail.join(' → ')}`).toBeNull()
      }
    }
  })

  it('50ラウンド × 20手を全部取り消すと、寸分違わず元へ戻る', () => {
    for (let r = 0; r < 50; r++) {
      reset()
      const start = snap()
      const trail: string[] = []
      for (let s = 0; s < 20; s++) {
        const op = pick(ops)
        trail.push(op.name)
        op.run()
      }
      const depth = st().past.length
      for (let i = 0; i < depth; i++) st().undo()
      expect(snap(), `手順: ${trail.join(' → ')}`).toBe(start)
    }
  })
})

describe('ノイズ除去・色合わせの差し替え', () => {
  beforeEach(reset)
  const asset = (id: string): Project['assets'][number] =>
    st().project.assets.find((a) => a.id === id)!

  it('ノイズを除いた音声に差し替え、外すと元の録音に戻る。どちらも1操作で元に戻せる', () => {
    st().setAssetsDenoised({ M: '/cache/m-clean.flac' })
    expect(asset('M').filePath).toBe('/cache/m-clean.flac')
    expect(asset('M').denoisedFrom).toBe('/x/m.m4a')
    // 掛け直しても、元の録音は最初のまま覚えている
    st().setAssetsDenoised({ M: '/cache/m-clean2.flac' })
    expect(asset('M').denoisedFrom).toBe('/x/m.m4a')
    st().setAssetsDenoised({ M: null })
    expect(asset('M').filePath).toBe('/x/m.m4a')
    expect(asset('M').denoisedFrom).toBeUndefined()
    st().undo()
    expect(asset('M').filePath).toBe('/cache/m-clean2.flac')
  })

  it('開いたときの自動の戻しは、元に戻すの履歴に積まない', () => {
    st().setAssetsDenoised({ M: '/cache/m-clean.flac' })
    const past = st().past.length
    st().setAssetsDenoised({ M: null }, { history: false })
    expect(st().past.length).toBe(past)
    expect(asset('M').filePath).toBe('/x/m.m4a')
  })

  it('色合わせを付け外しでき、関係のない素材は変えない', () => {
    st().setColorMatches({ B: { gain: [1.1, 1, 0.9], offset: [0, 0, 0.02] } })
    expect(asset('B').colorMatch?.gain).toEqual([1.1, 1, 0.9])
    expect(asset('A').colorMatch).toBeUndefined()
    st().setColorMatches({ B: undefined })
    expect(asset('B').colorMatch).toBeUndefined()
  })
})

describe('自動の SE・BGM', () => {
  beforeEach(reset)
  const placed = (path: string, startTime: number): PlacedSound => ({
    path,
    startTime,
    inPoint: 0,
    outPoint: 1,
    volume: 0.8,
    reason: ''
  })
  const kitAsset = (id: string, filePath: string): Project['assets'][number] => ({
    id,
    filePath,
    fileName: filePath,
    duration: 60,
    width: 0,
    height: 0,
    fps: 30,
    hasAudio: true,
    hasVideo: false
  })

  it('SE と BGM(ダッキング入り)のトラックを置き、作り直すと入れ替わる', () => {
    st().setAutoSounds(
      [
        { role: 'se', clips: [placed('/se/a.wav', 2)] },
        { role: 'bgm', clips: [placed('/bgm/x.mp3', 0)] }
      ],
      [kitAsset('se1', '/se/a.wav'), kitAsset('bgm1', '/bgm/x.mp3')]
    )
    const auto = st().project.audioTracks.filter((t) => t.autoRole)
    expect(auto.map((t) => [t.autoRole, t.duckingEnabled, t.clips.length])).toEqual([
      ['se', false, 1],
      ['bgm', true, 1]
    ])
    st().setAutoSounds([{ role: 'se', clips: [placed('/se/a.wav', 5)] }], [])
    const again = st().project.audioTracks.filter((t) => t.autoRole)
    expect(again).toHaveLength(1)
    expect(again[0].clips[0].startTime).toBe(5)
  })

  it('手で直した自動のトラックは、作り直しても消さずに残す(自動の印は外す)', () => {
    st().setAutoSounds(
      [{ role: 'se', clips: [placed('/se/a.wav', 2)] }],
      [kitAsset('se1', '/se/a.wav')]
    )
    const track = st().project.audioTracks.find((t) => t.autoRole === 'se')!
    st().updateAudioClipStart(track.id, track.clips[0].id, 3)
    st().setAutoSounds([{ role: 'se', clips: [placed('/se/a.wav', 9)] }], [])
    const tracks = st().project.audioTracks.filter((t) => t.name === 'SE(自動)')
    expect(tracks).toHaveLength(2)
    expect(tracks.find((t) => !t.autoRole)?.clips[0].startTime).toBe(3)
  })
})

describe('自動の版面CG', () => {
  beforeEach(reset)
  it('全面のトラックに置き、手で直したものは作り直しでも残す', () => {
    const cgAsset: Project['assets'][number] = {
      id: 'cg1',
      filePath: '/cg/a.mov',
      fileName: 'a.mov',
      duration: 3,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: false,
      hasVideo: true
    }
    st().setAutoCg(
      [{ path: '/cg/a.mov', startTime: 4, inPoint: 0, outPoint: 3, keyword: 'うまい' }],
      [cgAsset]
    )
    const track = st().project.videoOverlayTracks.find((t) => t.autoRole === 'cg')!
    expect([track.position, track.clips[0].startTime]).toEqual(['full', 4])
    // 作り直し(中身を変えていない)は入れ替わる
    st().setAutoCg(
      [{ path: '/cg/a.mov', startTime: 6, inPoint: 0, outPoint: 3, keyword: 'うまい' }],
      []
    )
    expect(st().project.videoOverlayTracks.filter((t) => t.name === 'CG(自動)')).toHaveLength(1)
    // 何も置かないなら、自動のトラックは消える
    st().setAutoCg([], [])
    expect(st().project.videoOverlayTracks.filter((t) => t.autoRole)).toHaveLength(0)
  })
})

describe('人の修正を作り直しで上書きしない', () => {
  beforeEach(reset)
  const cut = { main: [], audio: [], duration: 10, spans: [] }
  const telop = (u: string, text: string, start: number): Omit<TextOverlay, 'id'> => ({
    text,
    startTime: start,
    endTime: start + 1,
    style: defaultTextStyle(),
    utteranceId: u,
    utteranceChunk: 0
  })

  it('直したテロップは作り直しても残り、消したものは足し直さない。確認済みは保存される', () => {
    st().applyRoughCut(cut, [telop('u1', '一', 0), telop('u2', '二', 2), telop('u3', '三', 4)])
    const byText = (t: string): TextOverlay => st().project.textOverlays.find((o) => o.text === t)!
    st().updateTextOverlay(byText('一').id, { text: '一(直した)' })
    st().removeTextOverlay(byText('三').id)
    expect(st().project.dismissedTelops).toEqual(['u:u3#0'])
    st().applyRoughCut(cut, [telop('u1', '一', 1), telop('u2', '二', 3), telop('u3', '三', 5)])
    expect(
      st()
        .project.textOverlays.filter((o) => o.utteranceId)
        .map((o) => [o.text, o.startTime])
    ).toEqual([
      ['一(直した)', 1],
      ['二', 3]
    ])
    st().setReviewed('sync:x', true)
    expect(st().project.reviewed).toEqual(['sync:x'])
    st().setReviewed('sync:x', false)
    expect(st().project.reviewed).toBeUndefined()
  })
})

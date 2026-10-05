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

  it('手で直した自動のトラックは、作り直しても消さずに残し、その種類は二重に置かない', () => {
    st().setAutoSounds(
      [{ role: 'se', clips: [placed('/se/a.wav', 2)] }],
      [kitAsset('se1', '/se/a.wav')]
    )
    const track = st().project.audioTracks.find((t) => t.autoRole === 'se')!
    st().updateAudioClipStart(track.id, track.clips[0].id, 3)
    st().setAutoSounds([{ role: 'se', clips: [placed('/se/a.wav', 9)] }], [])
    const tracks = st().project.audioTracks.filter((t) => t.name === 'SE(自動)')
    expect(tracks).toHaveLength(1)
    expect(tracks[0].clips[0].startTime).toBe(3)
    expect(tracks[0].autoSignature).toBeUndefined()
    // もう一度作り直しても、手で直したトラックのまま
    st().setAutoSounds([{ role: 'se', clips: [placed('/se/a.wav', 12)] }], [])
    expect(st().project.audioTracks.filter((t) => t.name === 'SE(自動)')).toHaveLength(1)
  })

  it('消音・トラックの音量を変えただけでも、手で直したとみなす', () => {
    st().setAutoSounds(
      [{ role: 'bgm', clips: [placed('/bgm/a.wav', 0)] }],
      [kitAsset('b1', '/bgm/a.wav')]
    )
    const track = st().project.audioTracks.find((t) => t.autoRole === 'bgm')!
    st().toggleAudioTrackMute(track.id)
    st().setAutoSounds([{ role: 'bgm', clips: [placed('/bgm/a.wav', 0)] }], [])
    const bgm = st().project.audioTracks.filter((t) => t.autoRole === 'bgm')
    expect(bgm).toHaveLength(1)
    expect(bgm[0].muted).toBe(true)
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
  it('CG のトラックの大きさ・位置を手で変えたら、作り直しでも全面に戻さない', () => {
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
    const place = [{ path: '/cg/a.mov', startTime: 4, inPoint: 0, outPoint: 3, keyword: 'うまい' }]
    st().setAutoCg(place, [cgAsset])
    const id = st().project.videoOverlayTracks.find((t) => t.autoRole === 'cg')!.id
    st().setVideoOverlayTrackScale(id, 0.5)
    st().setVideoOverlayTrackPosition(id, 'top-left')
    st().setAutoCg(place, [])
    const kept = st().project.videoOverlayTracks.filter((t) => t.position === 'top-left')
    expect(kept.map((t) => t.scale)).toEqual([0.5])
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

  it('「このままでよい」は未保存の印を立て、取り消し・やり直しの1件になる', () => {
    useProjectStore.setState({ isDirty: false })
    st().setProjectName('名前を変えた')
    st().setReviewed('k2', true)
    expect(st().isDirty).toBe(true)
    st().undo()
    expect(st().project.reviewed).toBeUndefined()
    st().undo()
    expect(st().project.name).not.toBe('名前を変えた')
    st().redo()
    st().redo()
    expect(st().project.reviewed).toEqual(['k2'])
  })

  it('直したテロップは、場面を落としてタイムラインから外れても、戻したときに直した内容で出る', () => {
    st().applyRoughCut(cut, [telop('u1', '一', 0), telop('u2', '二', 2)])
    const one = st().project.textOverlays.find((o) => o.text === '一')!
    st().updateTextOverlay(one.id, { text: '一(直した)' })
    // 場面を落とした(u1 の発言が仮編集から外れた)
    st().applyRoughCut(cut, [telop('u2', '二', 0)])
    expect(st().project.textOverlays.some((o) => o.utteranceId === 'u1')).toBe(false)
    // 場面を戻した
    st().applyRoughCut(cut, [telop('u1', '一', 0), telop('u2', '二', 2)])
    expect(st().project.textOverlays.find((o) => o.utteranceId === 'u1')?.text).toBe('一(直した)')
  })
})

describe('仮編集の作り直しで、人が決めた音・差し込んだクリップを残す', () => {
  beforeEach(reset)
  const info = {
    anchorSourceId: 'A',
    sources: [
      { id: 'A', name: 'カメラA', kind: 'camera' as const },
      { id: 'M', name: '出演者A', kind: 'mic' as const }
    ],
    files: [
      { assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 },
      { assetId: 'micM', sourceId: 'M', start: 0, rate: 1, duration: 100 }
    ]
  }
  const cutOf = (
    ranges: [number, number][]
  ): Parameters<ReturnType<typeof st>['applyRoughCut']>[0] => {
    let t = 0
    const main = ranges.map(([a, b]) => ({ assetId: 'camA', inPoint: a, outPoint: b, speed: 1 }))
    const clips = ranges.map(([a, b]) => {
      const c = { assetId: 'micM', startTime: t, inPoint: a, outPoint: b, speed: 1 }
      t += b - a
      return c
    })
    return {
      main,
      audio: [{ name: '出演者A', sourceId: 'M', volume: 1, clips }],
      duration: t,
      spans: []
    }
  }

  it('マイクの消音・手で変えた音量は残し、手を付けていない音量は仮編集の値に合わせる', () => {
    S.setState({ project: { ...st().project, multicam: info } })
    st().applyRoughCut(cutOf([[0, 10]]), [])
    const mic = st().project.audioTracks.find((t) => t.multicamSourceId === 'M')!
    st().toggleAudioTrackMute(mic.id)
    st().setAudioTrackVolume(mic.id, 0.5)
    st().applyRoughCut(
      { ...cutOf([[0, 8]]), audio: [{ ...cutOf([[0, 8]]).audio[0], volume: 0.9 }] },
      []
    )
    const after = st().project.audioTracks.find((t) => t.multicamSourceId === 'M')!
    expect([after.muted, after.volume]).toEqual([true, 0.5])
  })

  it('本編のクリップを消す・伸ばすと、ピンマイクの声と自動テロップが本編に付いてくる', () => {
    S.setState({ project: { ...st().project, multicam: info, clips: [], textOverlays: [] } })
    st().applyRoughCut(
      cutOf([
        [0, 10],
        [20, 30],
        [40, 50]
      ]),
      [
        {
          text: '二つ目',
          startTime: 11,
          endTime: 12,
          style: defaultTextStyle(),
          utteranceId: 'u2',
          utteranceChunk: 0
        },
        {
          text: '一つ目',
          startTime: 2,
          endTime: 3,
          style: defaultTextStyle(),
          utteranceId: 'u1',
          utteranceChunk: 0
        }
      ]
    )
    const micClips = (): [number, number, number][] =>
      st()
        .project.audioTracks.find((t) => t.multicamSourceId === 'M')!
        .clips.map((c) => [c.startTime, c.inPoint, c.outPoint])
    st().removeClip(st().project.clips[0].id)
    // 映像は素材の 20 秒から。声も 20 秒から、テロップも 10 秒前へ
    expect(st().project.clips[0].inPoint).toBe(20)
    expect(micClips()).toEqual([
      [0, 20, 30],
      [10, 40, 50]
    ])
    const telops = st().project.textOverlays.filter((o) => o.utteranceId)
    expect(telops.map((o) => [o.text, o.startTime, o.endTime])).toEqual([['二つ目', 1, 2]])
    // 取り消すと元どおり
    st().undo()
    expect(micClips()[0]).toEqual([0, 0, 10])
    st().redo()
    // 本編のクリップを伸ばすと、新しく見えた所に声が入る
    const first = st().project.clips[0]
    st().updateClipTrim(first.id, 20, 35)
    expect(micClips()).toEqual([
      [0, 20, 30],
      [10, 30, 35],
      [15, 40, 50]
    ])
  })

  it('本編の後ろの方を消しても、前の(動かない)ピンマイクのクリップは元のまま(履歴で共有する)', () => {
    // 作り直すと、取り消しの履歴が1件ごとに全部のクリップを抱え、長尺で数十万個になる
    S.setState({ project: { ...st().project, multicam: info, clips: [], textOverlays: [] } })
    st().applyRoughCut(
      cutOf([
        [0, 10],
        [20, 30],
        [40, 50]
      ]),
      []
    )
    const mic = (): Project['audioTracks'][number] =>
      st().project.audioTracks.find((t) => t.multicamSourceId === 'M')!
    const before = mic().clips
    st().removeClip(st().project.clips[2].id)
    expect(mic().clips).toHaveLength(2)
    expect(mic().clips[0]).toBe(before[0])
    expect(mic().clips[1]).toBe(before[1])
  })

  it('仮編集を作り直しても、本編に紐づけた手置きのテロップは同じ場面のクリップに付いたまま', () => {
    const camAsset: Project['assets'][number] = {
      id: 'camA',
      filePath: '/rec/camA.mp4',
      fileName: 'camA.mp4',
      duration: 100,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      hasVideo: true
    }
    S.setState({
      project: { ...st().project, multicam: info, assets: [camAsset], clips: [], textOverlays: [] }
    })
    st().applyRoughCut(
      cutOf([
        [0, 10],
        [20, 30]
      ]),
      []
    )
    const second = st().project.clips[1]
    S.setState({
      project: {
        ...st().project,
        textOverlays: [
          {
            id: 'manual',
            text: '手置き',
            startTime: 12,
            endTime: 13,
            style: defaultTextStyle(),
            linkedClipId: second.id,
            linkOffset: 2
          }
        ]
      }
    })
    // 頭の 5 秒を落として作り直す: 素材の 22 秒は、タイムラインの 7 秒へ
    st().applyRoughCut(
      cutOf([
        [5, 10],
        [20, 30]
      ]),
      []
    )
    const o = st().project.textOverlays.find((x) => x.id === 'manual')!
    expect(o.linkedClipId).toBe(st().project.clips[1].id)
    expect([o.startTime, o.linkOffset]).toEqual([7, 2])
  })

  it('仮編集の声のクリップの切れ目のフェードを残す', () => {
    S.setState({ project: { ...st().project, multicam: info, clips: [] } })
    const cut = cutOf([[0, 10]])
    cut.audio[0].clips[0] = { ...cut.audio[0].clips[0], fadeIn: 0.02, fadeOut: 0.02 }
    st().applyRoughCut(cut, [])
    const clip = st().project.audioTracks.find((t) => t.multicamSourceId === 'M')!.clips[0]
    expect([clip.fadeIn, clip.fadeOut]).toEqual([0.02, 0.02])
  })

  it('収録素材以外のクリップ(差し込みの画)は、直前のクリップの続きに入れ直す', () => {
    S.setState({ project: { ...st().project, multicam: info, clips: [] } })
    st().applyRoughCut(
      cutOf([
        [0, 10],
        [20, 30]
      ]),
      []
    )
    const insert = { id: 'broll', assetId: 'broll-asset', inPoint: 0, outPoint: 3, speed: 1 }
    const clips = st().project.clips
    S.setState({ project: { ...st().project, clips: [clips[0], insert, clips[1]] } })
    st().applyRoughCut(
      cutOf([
        [0, 9],
        [21, 30]
      ]),
      [
        {
          text: '後半',
          startTime: 10,
          endTime: 11,
          style: defaultTextStyle(),
          utteranceId: 'u2',
          utteranceChunk: 0
        }
      ]
    )
    expect(
      st().project.clips.map((c) => (c.id === 'broll' ? 'broll' : `${c.inPoint}-${c.outPoint}`))
    ).toEqual(['0-9', 'broll', '21-30'])
    // 差し込み(3秒)の後ろの声とテロップは、差し込みの長さだけ後ろへ(素材の 22 秒 = タイムラインの 13 秒)
    const mic = st().project.audioTracks.find((t) => t.multicamSourceId === 'M')!
    expect(mic.clips.map((c) => [c.startTime, c.inPoint, c.outPoint])).toEqual([
      [0, 0, 9],
      [12, 21, 30]
    ])
    expect(st().project.textOverlays.find((o) => o.utteranceId === 'u2')?.startTime).toBe(13)
  })
})

describe('本編を直したときの追従 — 速さ・差し込み・直したテロップ', () => {
  beforeEach(reset)
  const info = {
    anchorSourceId: 'A',
    sources: [
      { id: 'A', name: 'カメラA', kind: 'camera' as const },
      { id: 'M', name: '出演者A', kind: 'mic' as const }
    ],
    files: [
      { assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 },
      { assetId: 'micM', sourceId: 'M', start: 0, rate: 1, duration: 100 }
    ]
  }
  const cutOf = (
    ranges: [number, number][]
  ): Parameters<ReturnType<typeof st>['applyRoughCut']>[0] => {
    let t = 0
    const main = ranges.map(([a, b]) => ({ assetId: 'camA', inPoint: a, outPoint: b, speed: 1 }))
    const clips = ranges.map(([a, b]) => {
      const c = { assetId: 'micM', startTime: t, inPoint: a, outPoint: b, speed: 1 }
      t += b - a
      return c
    })
    return {
      main,
      audio: [{ name: '出演者A', sourceId: 'M', volume: 1, clips }],
      duration: t,
      spans: []
    }
  }
  const telop = (
    id: string,
    text: string,
    startTime: number,
    endTime: number
  ): Omit<TextOverlay, 'id'> => ({
    text,
    startTime,
    endTime,
    style: defaultTextStyle(),
    utteranceId: id,
    utteranceChunk: 0
  })
  const micClips = (): [number, number, number][] =>
    st()
      .project.audioTracks.find((t) => t.multicamSourceId === 'M')!
      .clips.map((c) => [c.startTime, c.inPoint, c.outPoint])

  it('本編のクリップの速さを変えても、後ろの声は詰めた所へ動き、声どうしが重ならない', () => {
    S.setState({ project: { ...st().project, multicam: info, clips: [], textOverlays: [] } })
    st().applyRoughCut(
      cutOf([
        [0, 10],
        [20, 30]
      ]),
      [telop('u2', '後半', 12, 13)]
    )
    st().updateClipSpeed(st().project.clips[0].id, 2)
    // 1本目は 5 秒になる。2本目の声(素材の 20 秒〜)とテロップは 5 秒前へ
    expect(micClips().filter((c) => c[1] >= 20)).toEqual([[5, 20, 30]])
    const clips = micClips().sort((a, b) => a[0] - b[0])
    for (let i = 1; i < clips.length; i++) {
      const prev = clips[i - 1]
      expect(prev[0] + (prev[2] - prev[1])).toBeLessThanOrEqual(clips[i][0] + 1e-9)
    }
    expect(st().project.textOverlays.find((o) => o.utteranceId === 'u2')?.startTime).toBe(7)
  })

  it('差し込んだ画の下の自動 BGM は、ほかの所を直しても切れない', () => {
    S.setState({ project: { ...st().project, multicam: info, clips: [], textOverlays: [] } })
    st().applyRoughCut(
      cutOf([
        [0, 10],
        [20, 30],
        [40, 50]
      ]),
      []
    )
    const clips = st().project.clips
    const insert = { id: 'broll', assetId: 'broll-asset', inPoint: 0, outPoint: 3, speed: 1 }
    const mic = st().project.audioTracks.find((t) => t.multicamSourceId === 'M')!
    S.setState({
      project: {
        ...st().project,
        clips: [clips[0], insert, clips[1], clips[2]],
        audioTracks: [
          ...st().project.audioTracks,
          {
            ...mic,
            id: 'bgm',
            name: 'BGM',
            multicamSourceId: undefined,
            autoRole: 'bgm',
            clips: [{ id: 'b1', assetId: 'bgmA', startTime: 0, inPoint: 0, outPoint: 33 }]
          }
        ]
      }
    })
    st().removeClip(clips[2].id)
    const bgm = st().project.audioTracks.find((t) => t.id === 'bgm')!
    expect(bgm.clips.map((c) => [c.startTime, c.inPoint, c.outPoint])).toEqual([[0, 0, 23]])
  })

  it('人が直した自動テロップは、本編から外れて消えても、場面を戻して作り直すと直した内容で出る', () => {
    S.setState({ project: { ...st().project, multicam: info, clips: [], textOverlays: [] } })
    const cut = cutOf([
      [0, 10],
      [20, 30]
    ])
    st().applyRoughCut(cut, [telop('u1', '元', 2, 3)])
    const o = st().project.textOverlays.find((x) => x.utteranceId === 'u1')!
    st().updateTextOverlay(o.id, { text: '直した' })
    st().removeClip(st().project.clips[0].id)
    expect(st().project.textOverlays.find((x) => x.utteranceId === 'u1')).toBeUndefined()
    st().applyRoughCut(cut, [telop('u1', '元', 2, 3)])
    expect(st().project.textOverlays.find((x) => x.utteranceId === 'u1')?.text).toBe('直した')
  })

  it('長さの無い自動テロップも、本編を直したときに消さずに動かす', () => {
    S.setState({ project: { ...st().project, multicam: info, clips: [], textOverlays: [] } })
    st().applyRoughCut(
      cutOf([
        [0, 10],
        [20, 30]
      ]),
      [telop('u2', '点', 12, 12)]
    )
    st().removeClip(st().project.clips[0].id)
    const o = st().project.textOverlays.find((x) => x.utteranceId === 'u2')
    expect([o?.startTime, o?.endTime]).toEqual([2, 2])
  })
})

describe('静止画の素材', () => {
  beforeEach(reset)
  it('静止画は本編に置けない(ワイプ・全面(CG)のトラック用)', () => {
    S.setState({
      project: {
        ...st().project,
        assets: [
          ...st().project.assets,
          {
            id: 'png',
            filePath: '/cg/a.png',
            fileName: 'a.png',
            duration: 3600,
            width: 1920,
            height: 1080,
            fps: 30,
            hasAudio: false,
            hasVideo: true,
            still: true
          }
        ]
      }
    })
    const before = st().project.clips.length
    st().addClipToTimeline('png')
    st().insertClipAtTime('png', 0, 3, 0)
    st().addTrimmedClipToTimeline('png', 0, 3)
    expect(st().project.clips.length).toBe(before)
  })
})

describe('テロップの検索と置換', () => {
  beforeEach(reset)
  it('一括で置き換え、自動テロップには直した印を付け、1回で取り消せる', () => {
    S.setState({
      project: {
        ...st().project,
        textOverlays: [
          {
            id: 'a',
            text: '宮古島に到着',
            startTime: 0,
            endTime: 1,
            style: defaultTextStyle(),
            utteranceId: 'u1',
            utteranceChunk: 0
          },
          { id: 'b', text: '宮古島の水', startTime: 2, endTime: 3, style: defaultTextStyle() },
          { id: 'c', text: '関係ない', startTime: 4, endTime: 5, style: defaultTextStyle() }
        ]
      }
    })
    expect(st().replaceTelopText('宮古島', '宮古', {})).toBe(2)
    const byId = (id: string): TextOverlay => st().project.textOverlays.find((o) => o.id === id)!
    expect([byId('a').text, byId('b').text, byId('c').text]).toEqual([
      '宮古に到着',
      '宮古の水',
      '関係ない'
    ])
    expect(byId('a').edited).toBe(true)
    expect(byId('b').edited).toBeUndefined()
    st().undo()
    expect(byId('a').text).toBe('宮古島に到着')
    expect(st().replaceTelopText('無い言葉', 'x')).toBe(0)
  })
})

describe('壊れたファイルを開く・素材をつなぎ直す', () => {
  beforeEach(reset)
  const load = (mutate: (p: Project) => void): Project => {
    const p = JSON.parse(JSON.stringify(baseProject())) as Project
    mutate(p)
    st().loadProject(p, '/x/p.json')
    return st().project
  }

  it('終わりが頭より前・素材より先のクリップは、素材の尺の中の正しい区間にする', () => {
    const p = load((p) => {
      p.clips[2].outPoint = -5
      p.audioTracks[0].clips[0].outPoint = -5
      p.videoOverlayTracks[0].clips[0].inPoint = 99999
    })
    expect(brokenInvariant(p)).toBeNull()
    for (const c of [
      ...p.clips,
      ...p.audioTracks.flatMap((t) => t.clips),
      ...p.videoOverlayTracks.flatMap((t) => t.clips)
    ]) {
      expect(c.outPoint).toBeGreaterThan(c.inPoint)
    }
    const pip = p.videoOverlayTracks[0].clips[0]
    const dur = p.assets.find((a) => a.id === pip.assetId)!.duration
    expect(pip.outPoint).toBeLessThanOrEqual(dur)
  })

  it('終わりが頭より前のテロップ・とても大きな時刻は、保存し直しても変わらない形にする', () => {
    const p = load((p) => {
      p.textOverlays[1].startTime = 9
      p.textOverlays[1].endTime = 2
      p.textOverlays[0].startTime = 1e308
    })
    for (const o of p.textOverlays) expect(o.endTime).toBeGreaterThanOrEqual(o.startTime)
    const again = JSON.parse(JSON.stringify(p)) as Project
    st().loadProject(again, '/x/p.json')
    expect(st().project.textOverlays.map((o) => [o.startTime, o.endTime])).toEqual(
      p.textOverlays.map((o) => [o.startTime, o.endTime])
    )
  })

  it('同じ id が2つあれば後の方に新しい id を振り、紐づく音声・テロップは最初のクリップに付いたまま', () => {
    const p = load((p) => {
      p.clips[1].id = 'c1'
      p.textOverlays[1].id = 'o1'
      p.audioTracks[0].clips[0].id = 'a2'
    })
    expect(brokenInvariant(p)).toBeNull()
    expect(new Set(p.clips.map((c) => c.id)).size).toBe(p.clips.length)
    expect(new Set(p.textOverlays.map((o) => o.id)).size).toBe(p.textOverlays.length)
    const linked = p.audioTracks.flatMap((t) => t.clips).find((c) => c.linkedClipId === 'c1')!
    expect([linked.startTime, linked.inPoint, linked.outPoint]).toEqual([0, 0, 4])
  })

  it('長さを測れなかったファイルへつなぎ直しても、クリップを長さ0にしない', () => {
    st().loadProject(baseProject(), '/x/p.json')
    st().relinkAsset('A', '/y/a.mp4', 'a.mp4', {
      duration: 0,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      hasVideo: true
    })
    const a = st().project.clips.filter((c) => c.assetId === 'A')
    expect(a.map((c) => [c.inPoint, c.outPoint])).toEqual([
      [0, 4],
      [2, 6]
    ])
  })

  it('静止画へつなぎ直すと静止画の長さのまま、動画へつなぎ直すと静止画の印を外す', () => {
    st().loadProject(baseProject(), '/x/p.json')
    const probe = { width: 1, height: 1, fps: 30, hasAudio: false, hasVideo: true }
    st().relinkAsset('B', '/y/b.png', 'b.png', { ...probe, duration: 0.04 })
    const b = st().project.assets.find((x) => x.id === 'B')!
    expect([b.still, b.duration]).toEqual([true, 3600])
    expect(st().project.clips.find((c) => c.id === 'c2')!.outPoint).toBe(5)
    st().relinkAsset('B', '/y/b.mp4', 'b.mp4', { ...probe, duration: 30 })
    expect(st().project.assets.find((x) => x.id === 'B')!.still).toBeUndefined()
  })
})

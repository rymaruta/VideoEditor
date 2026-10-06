import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '@renderer/store/projectStore'
import type { Project } from '@shared/types'

const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()

const projA = (): Project =>
  ({
    id: 'A',
    name: '企画A',
    aspectRatio: '16:9',
    assets: [
      {
        id: 'asset-A',
        filePath: '/x/a.mp4',
        fileName: 'a.mp4',
        duration: 10,
        width: 1280,
        height: 720,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      }
    ],
    clips: [{ id: 'ca', assetId: 'asset-A', inPoint: 0, outPoint: 5, speed: 1 }],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    beatGrid: null
  }) as unknown as Project

const projB = (): Project =>
  ({
    ...projA(),
    id: 'B',
    name: '企画B',
    assets: [
      {
        id: 'asset-B',
        filePath: '/x/b.mp4',
        fileName: 'b.mp4',
        duration: 10,
        width: 1280,
        height: 720,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      }
    ],
    clips: [{ id: 'cb', assetId: 'asset-B', inPoint: 0, outPoint: 5, speed: 1 }]
  }) as unknown as Project

/** 前の企画の「残りかす」を全部作ってから切り替える */
function dirtyEverything(): void {
  st().loadProject(projA(), '/tmp/A.veproj')
  st().openInSourceViewer('asset-A')
  st().setSourceIn(1.5)
  st().setSourceOut(4.25)
  st().selectClip('ca')
  st().copySelectedClip()
  st().setPlayheadTime(3.5)
  st().setIsPlaying(true)
  st().setSaveError('保存に失敗しました(前の企画のエラー)')
  st().setMissingAssetPaths(['/x/a.mp4'])
}

/** 切り替えたあとに残っていてはいけないもの */
function leftovers(): Record<string, unknown> {
  const s = st()
  return {
    sourceAssetId: s.sourceAssetId,
    sourceIn: s.sourceIn,
    sourceOut: s.sourceOut,
    saveError: s.saveError,
    selectedClipId: s.selectedClipId,
    multiSelectedClipIds: s.multiSelectedClipIds,
    clipboardClips: s.clipboardClips,
    playheadTime: s.playheadTime,
    isPlaying: s.isPlaying,
    seekRequest: s.seekRequest,
    missingAssetPaths: s.missingAssetPaths,
    missingAssetIds: s.missingAssetIds,
    past: s.past,
    future: s.future
  }
}

const CLEAN = {
  sourceAssetId: null,
  sourceIn: null,
  sourceOut: null,
  saveError: null,
  selectedClipId: null,
  multiSelectedClipIds: [],
  clipboardClips: [],
  playheadTime: 0,
  isPlaying: false,
  seekRequest: null,
  missingAssetPaths: [],
  missingAssetIds: [],
  past: [],
  future: []
}

describe('【レグレッション】企画を切り替えると、前の企画の残りかすが全部消える (2026-09-12)', () => {
  /**
   * 「開く」「新規作成」「自動保存から復元」の3経路が、捨てる state の一覧を
   * 手で並べていたので食い違っていた。
   * - `saveError` は開く/復元だけが捨て、**新規作成は残していた**
   *   (実測: 出ている状態で新規作成を押すと、空の新しい企画の画面に前のエラー文が残る)
   * - ソースビューア(`sourceAssetId`/`sourceIn`/`sourceOut`)は**3経路とも捨てていなかった**
   *   (実測: Aでビューアを開き選択範囲 1.5〜4.25 を打つ → Bを開く → **Aを開き直すと
   *   開いた覚えのないビューアが勝手に開き、打った覚えのない 1.5〜4.25 が入っている**)
   */
  beforeEach(() => {
    st().newProject()
  })

  it('企画を開くと、前の企画の残りかすが1つも残らない', () => {
    dirtyEverything()
    st().loadProject(projB(), '/tmp/B.veproj')
    expect(leftovers()).toEqual(CLEAN)
    expect(st().currentFilePath).toBe('/tmp/B.veproj')
    expect(st().project.name).toBe('企画B')
  })

  it('新規作成でも1つも残らない(ここだけ saveError を残していた)', () => {
    dirtyEverything()
    st().newProject()
    expect(leftovers()).toEqual(CLEAN)
    expect(st().currentFilePath).toBeNull()
    expect(st().isDirty).toBe(false)
  })

  it('自動保存から復元しても1つも残らない', () => {
    dirtyEverything()
    st().restoreAutosave(projB())
    expect(leftovers()).toEqual(CLEAN)
    expect(st().currentFilePath).toBeNull()
    // 復元した下書きはまだディスクに無いので、保存を促すため dirty のまま
    expect(st().isDirty).toBe(true)
  })

  it('同じ企画を開き直しても、ソースビューアは勝手に開かない', () => {
    st().loadProject(projA(), '/tmp/A.veproj')
    st().openInSourceViewer('asset-A')
    st().setSourceIn(1.5)
    st().setSourceOut(4.25)
    st().loadProject(projB(), '/tmp/B.veproj')
    // ここで state に asset-A が残っていると、A を開き直したとき勝手に開く
    expect(st().sourceAssetId).toBeNull()
    st().loadProject(projA(), '/tmp/A.veproj')
    expect(st().sourceAssetId).toBeNull()
    expect(st().sourceIn).toBeNull()
    expect(st().sourceOut).toBeNull()
  })

  it('3経路が捨てるものは**完全に同じ**(一覧が食い違わない)', () => {
    const after: Record<string, unknown>[] = []
    for (const run of [
      () => st().loadProject(projB(), '/tmp/B.veproj'),
      () => st().newProject(),
      () => st().restoreAutosave(projB())
    ]) {
      dirtyEverything()
      run()
      after.push(leftovers())
    }
    expect(after[1]).toEqual(after[0])
    expect(after[2]).toEqual(after[0])
  })

  it('素材が落ちたときの案内は、共有の一覧の null を上書きして残る', () => {
    // クリップが指す素材が居ない企画を開くと、落とした件数の案内が出る
    const orphaned = {
      ...projA(),
      clips: [
        { id: 'ca', assetId: 'asset-A', inPoint: 0, outPoint: 5, speed: 1 },
        { id: 'gone', assetId: '居ない素材', inPoint: 0, outPoint: 5, speed: 1 }
      ]
    } as unknown as Project
    st().loadProject(orphaned, '/tmp/O.veproj')
    expect(st().saveError).not.toBeNull()
    expect(st().isDirty).toBe(true)
    // それ以外の残りかすは消えている
    expect(st().sourceAssetId).toBeNull()
    expect(st().past).toEqual([])
  })

  it('対照: 素材を消したときの関門は今までどおり効く', () => {
    st().loadProject(projA(), '/tmp/A.veproj')
    st().openInSourceViewer('asset-A')
    st().setSourceIn(1)
    st().removeAsset('asset-A')
    expect(st().sourceAssetId).toBeNull()
    expect(st().sourceIn).toBeNull()
  })

  it('別の素材をビューアに出すと、前の素材の選択範囲は引き継がない', () => {
    st().loadProject(projA(), '/tmp/A.veproj')
    st().openInSourceViewer('asset-A')
    st().setSourceIn(1)
    st().setSourceOut(2)
    st().openInSourceViewer('asset-A')
    expect(st().sourceIn).toBeNull()
    expect(st().sourceOut).toBeNull()
  })
})

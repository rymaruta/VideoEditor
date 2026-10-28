import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})
import { useProjectStore } from '@renderer/store/projectStore'
import { switchRangesAngle } from '@renderer/lib/editCommands'
import { previewClipFollow } from '@renderer/lib/previewClipFollow'
import { buildTimedClips, findTimedClipAt, type TimedClip } from '@renderer/lib/timelineMath'
import { angleAlternatives } from '@shared/roughCut/overrides'
import { episode2, project } from '../audit/h'

/**
 * 確認の画面で範囲のカメラを替えた直後、範囲の頭のコマだけプログラムに前のカメラの絵が出ていた
 * (書き出しは正しい)。範囲の頭で分けた前のクリップは id もファイルもそのまま並びに残るので、
 * プログラムは読み込み直さず、範囲の頭(= 前のクリップの終わり)で前のカメラの絵を出し続けていた。
 */

const url = (tc: TimedClip): string => tc.asset.filePath

describe('本編が変わったときのプログラムの読み込み直し', () => {
  it('範囲のカメラを替えたら、再生位置(範囲の頭)の新しいクリップを読み込み直す', async () => {
    await episode2()
    // 別のカメラに替えられる、長さのあるクリップの真ん中を範囲にする
    const info = project().multicam!
    const timed = buildTimedClips(project())
    const tc = timed.find(
      (t) =>
        t.end - t.start > 2 &&
        angleAlternatives(t.clip, info).some((a) => !a.current && (a.clips?.length ?? 0) > 0)
    )!
    const other = angleAlternatives(tc.clip, info).find(
      (a) => !a.current && (a.clips?.length ?? 0) > 0
    )!.sourceId
    const range = { start: tc.start + 0.5, end: tc.end - 0.5 }
    // プログラムはこのクリップを読み込んで、範囲の頭に止まっている
    const activeId = tc.clip.id
    const activeUrl = url(tc)
    expect(previewClipFollow(timed, activeId, activeUrl, range.start, url).kind).toBe('keep')

    expect(switchRangesAngle([range], other)).toBe(true)
    const after = buildTimedClips(project())
    // 読み込んでいたクリップ(範囲の頭で分けた前半)は、id も素材のファイルもそのまま残っている
    const kept = after.find((t) => t.clip.id === activeId)!
    expect(url(kept)).toBe(activeUrl)
    // 再生位置のクリップは、替えたカメラの新しいクリップ
    const head = findTimedClipAt(after, range.start)!
    expect(head.clip.id).not.toBe(activeId)
    expect(info.files.find((f) => f.assetId === head.clip.assetId)?.sourceId).toBe(other)
    // そのままにせず、範囲の頭で読み込み直す
    expect(previewClipFollow(after, activeId, activeUrl, range.start, url)).toEqual({
      kind: 'load',
      time: range.start
    })
    useProjectStore.getState().undo()
  })

  it('再生位置のクリップが同じなら、読み込み直さない(再生を止めない)', () => {
    const asset = { id: 'a', filePath: '/a.mp4' } as TimedClip['asset']
    const clip = (id: string): TimedClip['clip'] =>
      ({ id, assetId: 'a', inPoint: 0, outPoint: 5, speed: 1 }) as TimedClip['clip']
    const timed: TimedClip[] = [
      { clip: clip('c1'), asset, start: 0, end: 5 },
      { clip: clip('c2'), asset, start: 5, end: 10 }
    ]
    expect(previewClipFollow(timed, 'c1', '/a.mp4', 2, url)).toEqual({
      kind: 'keep',
      current: timed[0]
    })
    // 消えた・最初・素材のファイルが替わった は今までどおり読み込み直す
    expect(previewClipFollow(timed, 'gone', '/a.mp4', 2, url).kind).toBe('load')
    expect(previewClipFollow(timed, null, null, 2, url)).toEqual({
      kind: 'load',
      time: 0,
      initial: true
    })
    expect(previewClipFollow(timed, 'c1', '/proxy.mp4', 2, url).kind).toBe('load')
  })
})

// ロックの中を手で詰め(時間の飛ぶカットの切れ目ができる)、作り直しても、ロックの中の発言テロップの
// 時刻は変わらない(fuzz の seed 36 で見つかった)。
// 作り直しは、切れ目の後ろの短い枚を読み切れる長さ(1秒10文字)へ延ばす。カメラが替わるだけの所は
// 切れ目ではないので、延ばした分がロックの終わりを越えて外に残り、ロックの中を前の枚に戻したあと、
// 境で1枚につながって、ロックの中の枚の終わりから境までの隙間が埋まっていた
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
import { usePipelineStore } from '@renderer/store/pipelineStore'
import { useProjectStore } from '@renderer/store/projectStore'
import { markIn, markOut, rippleDelete } from '@renderer/lib/editCommands'
import { subtractRanges, unionRanges, type Range } from '@shared/roughCut/overrides'
import { clipTimes, timelineWindowOf } from '@shared/roughCut/range'
import type { Project, TextOverlay } from '@shared/types'
import { episode2, len, project } from './h'

/** 窓(タイムライン)の頭からの、発言テロップの出ている所 */
function speechIn(p: Project, w: { start: number; end: number }): Range[] {
  return unionRanges(
    p.textOverlays
      .filter((x) => x.utteranceId)
      .map((x) => ({
        start: Math.max(w.start, x.startTime) - w.start,
        end: Math.min(w.end, x.endTime) - w.start
      }))
      .filter((x) => x.end > x.start + 1e-6)
  )
}

/**
 * 1本のクリップの中で終わる、長い発言のテロップ(終わりの後ろにクリップが 0.5 秒以上続き、
 * 次のテロップは 1 秒以上後)。その終わりの共通の時刻と、タイムラインの時刻
 */
function pickTelop(): {
  o: TextOverlay
  end: number
  commonEnd: number
  common: (x: number) => number
} {
  const p = project()
  const info = p.multicam!
  const t = clipTimes(p.clips)
  const speech = p.textOverlays
    .filter((x) => x.utteranceId)
    .sort((a, b) => a.startTime - b.startTime)
  for (let k = 0; k < speech.length; k++) {
    const o = speech[k]
    const next = speech[k + 1]?.startTime ?? Infinity
    if (o.text.replace(/\s/g, '').length < 14 || o.endTime - o.startTime < 4.5) continue
    if (next < o.endTime + 1) continue
    const i = p.clips.findIndex((_, j) => t[j].start <= o.startTime + 1e-6 && t[j].end > o.endTime)
    if (i < 0 || t[i].end - o.endTime < 0.5) continue
    const c = p.clips[i]
    const f = info.files.find((x) => x.assetId === c.assetId)
    if (!f || Math.abs((c.speed || 1) - 1) > 1e-9 || f.rate !== 1) continue
    const common = (x: number): number => f.start + c.inPoint + (x - t[i].start)
    return { o, end: o.endTime, commonEnd: common(o.endTime), common }
  }
  throw new Error('使える発言テロップがありません')
}

describe('ロックの中を手で詰めて作り直しても、ロックの中の発言テロップの時刻は変わらない', () => {
  it('切れ目の後ろの短い枚を延ばした分が、ロックの外へはみ出してつながらない', async () => {
    await episode2()
    const { o, end, commonEnd, common } = pickTelop()
    // 発言の終わりのすぐ後ろ(0.08 秒)までをロックする
    const lock = { start: common(o.startTime + 0.5), end: commonEnd + 0.08 }
    useProjectStore.getState().addAutoEditLock(lock)
    // ロックの中を詰める(発言の終わりの 0.9 秒前で時間が飛ぶ。後ろの枚は声 0.9 秒で、読むには短い)
    useProjectStore.getState().selectClip(null)
    useProjectStore.getState().seekTo(end - 3.5)
    markIn()
    useProjectStore.getState().seekTo(end - 0.9)
    markOut()
    expect(rippleDelete()).toBe(true)
    const before = project()
    const tw = timelineWindowOf(before.clips, before.multicam!, lock)!
    expect(tw).not.toBeNull()
    const r0 = speechIn(before, tw)
    expect(len(r0)).toBeGreaterThan(0)
    await usePipelineStore.getState().rebuildRoughCut()
    const now = project()
    const tn = timelineWindowOf(now.clips, now.multicam!, lock)!
    expect(tn).not.toBeNull()
    const r1 = speechIn(now, tn)
    expect(len(subtractRanges(r0, r1)) + len(subtractRanges(r1, r0))).toBeLessThan(0.02)
  })
})

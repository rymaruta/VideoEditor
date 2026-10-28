import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installLoopWatcher,
  LOOP_EDGE_SECONDS,
  loopBounds,
  loopRestartTime,
  restartLoopAtEnd
} from '@renderer/lib/loopPlayback'
import { playRange, stopRangePlayback } from '@renderer/lib/shuttle'
import { useProjectStore } from '@renderer/store/projectStore'
import type { MediaAsset, Project } from '@shared/types'

const asset: MediaAsset = {
  id: 'a',
  filePath: '/x/a.mp4',
  fileName: 'a.mp4',
  duration: 30,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  hasVideo: true
}

const project: Project = {
  id: 'p',
  name: 'p',
  aspectRatio: '16:9',
  assets: [asset],
  clips: [{ id: 'c', assetId: 'a', inPoint: 0, outPoint: 20, speed: 1 }],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: []
}

const s = useProjectStore.getState

describe('ループの範囲', () => {
  it('イン〜アウト。無い側はタイムラインの頭・終わり', () => {
    expect(loopBounds(2, 5, 20)).toEqual({ from: 2, to: 5 })
    expect(loopBounds(null, 5, 20)).toEqual({ from: 0, to: 5 })
    expect(loopBounds(2, null, 20)).toEqual({ from: 2, to: 20 })
    expect(loopBounds(null, null, 20)).toEqual({ from: 0, to: 20 })
    // アウトがタイムラインより後なら終わりで切る
    expect(loopBounds(2, 40, 20)).toEqual({ from: 2, to: 20 })
  })

  it('逆さま・同じイン〜アウトは全体。空のタイムラインは無し', () => {
    expect(loopBounds(5, 2, 20)).toEqual({ from: 0, to: 20 })
    expect(loopBounds(5, 5, 20)).toEqual({ from: 0, to: 20 })
    expect(loopBounds(null, null, 0)).toBeNull()
  })

  it('範囲の終わりを今越えたときだけ頭へ戻す(範囲の後ろから始めたら戻さない)', () => {
    const b = { from: 2, to: 5 }
    expect(loopRestartTime(4.9, 5 - LOOP_EDGE_SECONDS / 2, b)).toBe(2)
    expect(loopRestartTime(3, 4, b)).toBeNull()
    expect(loopRestartTime(6, 6.1, b)).toBeNull()
  })
})

describe('ループの再生(ストア)', () => {
  let uninstall: (() => void) | null = null
  beforeEach(() => {
    useProjectStore.setState({
      project,
      timelineIn: 2,
      timelineOut: 5,
      playheadTime: 0,
      isPlaying: false,
      loopPlayback: false
    })
  })
  afterEach(() => {
    uninstall?.()
    uninstall = null
    stopRangePlayback()
    s().setIsPlaying(false)
  })

  it('オンなら、ふつうの再生でアウトを越えたらインへ戻る。オフなら戻らない', () => {
    uninstall = installLoopWatcher()
    s().setIsPlaying(true)
    s().setPlayheadTime(4.9)
    s().setPlayheadTime(5)
    expect(s().playheadTime).toBe(5)
    s().setLoopPlayback(true)
    s().setPlayheadTime(4.9)
    s().setPlayheadTime(5)
    expect(s().playheadTime).toBe(2)
    expect(s().isPlaying).toBe(true)
  })

  it('Ctrl+Shift+Space(イン〜アウトを再生)は、オフならアウトで止まり、オンなら繰り返す', () => {
    expect(playRange(2, 5)).toBe(true)
    s().setPlayheadTime(5)
    expect(s().isPlaying).toBe(false)
    s().setLoopPlayback(true)
    expect(playRange(2, 5)).toBe(true)
    s().setPlayheadTime(5)
    expect(s().isPlaying).toBe(true)
    expect(s().playheadTime).toBe(2)
  })

  it('タイムラインの終わりに着いたとき、オンなら範囲の頭へ戻して続ける', () => {
    expect(restartLoopAtEnd()).toBe(false)
    s().setLoopPlayback(true)
    useProjectStore.setState({ timelineIn: null, timelineOut: null })
    expect(restartLoopAtEnd()).toBe(true)
    expect(s().playheadTime).toBe(0)
  })
})

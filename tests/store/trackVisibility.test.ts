import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeLoadedProject, useProjectStore } from '@renderer/store/projectStore'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import {
  autoBottomHeight,
  BOTTOM_SHARE,
  defaultBottomHeight,
  defaultSideWidths,
  NARROW_WINDOW_WIDTH,
  timelineNaturalHeight
} from '@renderer/lib/layoutDefaults'
import type { MediaAsset, Project } from '@shared/types'

/** V1・T1 の「目」(表示)と、画面の配分の既定 */

const asset: MediaAsset = {
  id: 'a',
  filePath: '/x/a.mp4',
  fileName: 'a.mp4',
  duration: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  hasVideo: true
}

const project = (extra: Partial<Project> = {}): Project => ({
  id: 'p',
  name: 'p',
  aspectRatio: '16:9',
  assets: [asset],
  clips: [{ id: 'c', assetId: 'a', inPoint: 0, outPoint: 4, speed: 1 }],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: [],
  ...extra
})

beforeEach(() => {
  useProjectStore.setState({ project: project(), past: [], future: [] })
})

describe('V1・T1 の「目」', () => {
  it('押すと隠れ・もう一度押すと戻る。どちらも取り消せる', () => {
    const s = useProjectStore.getState
    s().toggleMainVideoHidden()
    expect(s().project.mainVideoHidden).toBe(true)
    s().toggleTelopTrackHidden()
    expect(s().project.telopTrackHidden).toBe(true)
    s().undo()
    expect(s().project.telopTrackHidden).toBeFalsy()
    s().toggleMainVideoHidden()
    expect(s().project.mainVideoHidden).toBeFalsy()
  })

  it('区間ごとの書き出し(v2)では、本編のトラックを隠したものとして渡す。本編の音は残す', () => {
    const shown = projectV1ToV2(project(), { resolution: 720 })
    const hidden = projectV1ToV2(project({ mainVideoHidden: true }), { resolution: 720 })
    expect(shown.sequence.videoTracks[0].hidden).toBe(false)
    expect(hidden.sequence.videoTracks[0].hidden).toBe(true)
    expect(hidden.sequence.audioTracks.find((t) => t.id === 'a1-main')?.items).toHaveLength(1)
  })

  it('読み込み: true だけを残し、壊れた値は外す。項目の無い企画には足さない', () => {
    const raw = (extra: Record<string, unknown>): Project =>
      ({ ...project(), ...extra }) as unknown as Project
    expect(normalizeLoadedProject(raw({ mainVideoHidden: true })).mainVideoHidden).toBe(true)
    expect(
      normalizeLoadedProject(raw({ telopTrackHidden: 'yes' })).telopTrackHidden
    ).toBeUndefined()
    const plain = normalizeLoadedProject(project())
    expect('mainVideoHidden' in plain).toBe(false)
    expect('telopTrackHidden' in plain).toBe(false)
  })
})

describe('画面の配分の既定', () => {
  it('1440 未満の幅では 素材 240・インスペクタ 280、それ以上は 288・312', () => {
    expect(defaultSideWidths(1366)).toEqual({ left: 240, right: 280 })
    expect(defaultSideWidths(NARROW_WINDOW_WIDTH - 1)).toEqual({ left: 240, right: 280 })
    expect(defaultSideWidths(NARROW_WINDOW_WIDTH)).toEqual({ left: 288, right: 312 })
    expect(defaultSideWidths(1920)).toEqual({ left: 288, right: 312 })
  })
  it('タイムラインの中身の高さ = 帯など + 見出し・レーンの高い方(スクロールバーを含む)', () => {
    expect(
      timelineNaturalHeight({
        panelHeight: 480,
        tracksClientHeight: 400,
        labelsHeight: 300,
        lanesHeight: 310
      })
    ).toBe(80 + 310)
    // パネルの方が小さく、トラックが縮んでいても同じ値(配分が回らない)
    expect(
      timelineNaturalHeight({
        panelHeight: 200,
        tracksClientHeight: 120,
        labelsHeight: 300,
        lanesHeight: 310
      })
    ).toBe(80 + 310)
  })
})

describe('タイムラインの自動の高さ(中身に合わせる。上限は使える高さの半分)', () => {
  const chrome = 70
  it('中身が少なければ中身の高さ(残りはプログラムへ)', () => {
    expect(autoBottomHeight(1080, chrome, 180, 350)).toBe(350)
    expect(autoBottomHeight(768, chrome, 180, 300)).toBe(300)
  })
  it('トラックを足して中身が増えても、使える高さの半分で止める(溢れた分は縦に送る)', () => {
    // 1366×768 でトラックを 6 本足した(中身 700px)。モニターに半分を残す
    expect(autoBottomHeight(768, chrome, 180, 700)).toBe(Math.round((768 - chrome) * BOTTOM_SHARE))
    expect(autoBottomHeight(1080, chrome, 180, 1200)).toBe(
      Math.round((1080 - chrome) * BOTTOM_SHARE)
    )
  })
  it('とても低い窓でも下限(180)までは取る。測る前は今までの既定', () => {
    expect(autoBottomHeight(400, chrome, 180, 900)).toBe(180)
    expect(autoBottomHeight(768, chrome, 180, null)).toBe(defaultBottomHeight(768, chrome, 180))
  })
})

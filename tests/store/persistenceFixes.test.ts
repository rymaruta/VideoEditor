import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { useQcStore } from '@renderer/store/qcStore'
import { getKeymap } from '@renderer/lib/keymap'
import type { MediaAsset, Project } from '@shared/types'

/** 保存・開く・素材の管理(第5回の調査) */
const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()

const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  filePath: `/x/${id}.mp4`,
  fileName: `${id}.mp4`,
  duration: 10,
  width: 1280,
  height: 720,
  fps: 30,
  hasAudio: true,
  hasVideo: true,
  ...extra
})
const project = (assets: MediaAsset[], extra: Record<string, unknown> = {}): Project =>
  ({
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets,
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    ...extra
  }) as unknown as Project

describe('保存・開く・素材の管理', () => {
  beforeEach(() => st().newProject())

  it('ノイズを除いた素材を再リンクすると、ノイズ除去の印を外す(外すで前の録音へ戻らない)', () => {
    st().loadProject(
      project([
        asset('V', {
          filePath: '/cache/v.clean.flac',
          denoisedFrom: '/old/voice.wav',
          proxyBeforeDenoise: '/proxy/old.mp4',
          hasVideo: false
        })
      ]),
      '/p.veproj'
    )
    st().relinkAsset(
      'V',
      '/new/voice2.wav',
      'voice2.wav',
      { duration: 10, width: 0, height: 0, fps: 0, hasAudio: true, hasVideo: false },
      undefined
    )
    const v = st().project.assets[0]
    expect(v.filePath).toBe('/new/voice2.wav')
    expect(v.denoisedFrom).toBeUndefined()
    expect(v.proxyBeforeDenoise).toBeUndefined()
  })

  it('別のプロジェクトを開くと、前のプロジェクトの書き出しの確認結果を捨てる', () => {
    useQcStore.setState({
      report: { path: '/out/A.mp4', state: 'done', percent: 100, issues: [], measurement: null }
    })
    st().loadProject(project([asset('B')]), '/b.veproj')
    expect(useQcStore.getState().report).toBeNull()
  })

  it('開いたときのノイズ除去の自動の戻しは、履歴に積まずに未保存にする', () => {
    st().loadProject(
      project([asset('V', { filePath: '/cache/v.flac', denoisedFrom: '/orig/v.wav' })]),
      '/p.veproj'
    )
    expect(st().isDirty).toBe(false)
    const past = st().past.length
    st().setAssetsDenoised({ V: null }, { history: false })
    expect(st().project.assets[0].filePath).toBe('/orig/v.wav')
    expect(st().isDirty).toBe(true)
    expect(st().past.length).toBe(past)
  })

  it('同じ ID の素材が2つあっても、クリップは ID を持ち続ける素材の尺で整える', () => {
    st().loadProject(
      project(
        [asset('A', { duration: 10 }), asset('A', { duration: 3, filePath: '/x/other.mp4' })],
        {
          clips: [{ id: 'c', assetId: 'A', inPoint: 0, outPoint: 8, speed: 1 }]
        }
      ),
      '/p.veproj'
    )
    const c = st().project.clips[0]
    expect(st().project.assets.find((a) => a.id === c.assetId)!.duration).toBe(10)
    expect(c.outPoint).toBe(8)
  })

  it('知らない項目(新しい版の項目)も開いて残す', () => {
    st().loadProject(project([asset('A')], { futureField: { a: 1 } }), '/p.veproj')
    expect((st().project as unknown as Record<string, unknown>).futureField).toEqual({ a: 1 })
  })

  it('保存の途中で裏の変換が終わってプロキシが入っても、保存後は未保存にしない(編集は未保存)', () => {
    st().loadProject(project([asset('A')]), '/p.veproj')
    st().setProjectName('名前')
    const saved = st().project
    st().setAssetProxyPath('A', '/proxy/a.mp4')
    st().markSaved('/p.veproj', saved)
    expect(st().isDirty).toBe(false)
    // 保存の途中で人が編集したなら、未保存のまま
    st().setProjectName('名前2')
    const saved2 = st().project
    st().setAssetProxyPath('A', '/proxy/a2.mp4')
    st().setProjectName('名前3')
    st().markSaved('/p.veproj', saved2)
    expect(st().isDirty).toBe(true)
  })

  it('壊れたキー操作の型の名前(constructor など)でも、既定のキー操作を使う', () => {
    expect(getKeymap('constructor' as never)).toBe(getKeymap('default'))
    expect(getKeymap('garbage' as never)).toBe(getKeymap('default'))
  })
})

describe('設定の読み込み', () => {
  it('設定の保存領域が読めなくても、設定は既定値で起動する', async () => {
    vi.resetModules()
    const original = globalThis.localStorage
    globalThis.localStorage = {
      ...original,
      getItem: () => {
        throw new Error('SecurityError')
      }
    }
    try {
      const { useSettingsStore } = await import('@renderer/store/settingsStore')
      expect(useSettingsStore.getState().keymapScheme).toBe('default')
    } finally {
      globalThis.localStorage = original
    }
  })

  it('保存されたキー操作の型が知らない値なら既定にする', async () => {
    vi.resetModules()
    localStorage.setItem('ve-keymap-scheme', 'constructor')
    const { useSettingsStore } = await import('@renderer/store/settingsStore')
    expect(useSettingsStore.getState().keymapScheme).toBe('default')
    localStorage.removeItem('ve-keymap-scheme')
  })
})

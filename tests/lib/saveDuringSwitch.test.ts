import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openRecentProject,
  saveProject,
  saveProjectAs,
  startNewProject
} from '@renderer/lib/projectFileActions'
import { useProjectStore } from '@renderer/store/projectStore'
import type { Project } from '@shared/types'

/** 保存している間に新しい企画へ切り替えても、新しい企画の次の保存で前のファイルを上書きしない */
describe('保存の途中で企画を切り替える', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('保存が終わっても、新しい企画には前のファイルの場所を付けない', async () => {
    let finish: () => void = () => {}
    const saveProjectApi = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    vi.stubGlobal('window', {
      api: {
        saveProject: saveProjectApi,
        clearAutosave: vi.fn(async () => false),
        discardAutosave: vi.fn(async () => undefined),
        checkAutosave: vi.fn(async () => ({ exists: false, discardedExists: false }))
      }
    })
    vi.stubGlobal('confirm', () => true)
    const a = {
      id: 'A',
      name: 'A',
      aspectRatio: '16:9',
      assets: [],
      clips: [],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: [],
      beatGrid: null
    } as unknown as Project
    useProjectStore.getState().loadProject(a, '/tmp/A.veproj')
    useProjectStore.getState().setProjectName('A2')
    const saving = saveProject()
    await startNewProject()
    finish()
    await saving
    expect(useProjectStore.getState().currentFilePath).toBeNull()
  })

  for (const [name, save] of [
    ['上書き保存', saveProject],
    ['名前を付けて保存', saveProjectAs]
  ] as const) {
    it(`${name}の途中で同じ id の企画(写し・元)を開いても、開いた企画の場所のまま`, async () => {
      let finish: () => void = () => {}
      const clearAutosave = vi.fn(async () => false)
      const a = {
        id: 'A',
        name: 'A',
        aspectRatio: '16:9',
        assets: [],
        clips: [],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: [],
        beatGrid: null
      } as unknown as Project
      vi.stubGlobal('window', {
        api: {
          saveProject: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                finish = resolve
              })
          ),
          selectProjectSavePath: vi.fn(async () => '/tmp/B.veproj'),
          loadProject: vi.fn(async () => ({ ...a, name: '写し' })),
          checkFilesExist: vi.fn(async () => []),
          clearAutosave,
          discardAutosave: vi.fn(async () => undefined),
          checkAutosave: vi.fn(async () => ({ exists: false, discardedExists: false }))
        }
      })
      vi.stubGlobal('confirm', () => true)
      useProjectStore.getState().loadProject(a, '/tmp/A.veproj')
      useProjectStore.getState().setProjectName('A2')
      const saving = save()
      await new Promise((r) => setTimeout(r, 0))
      await openRecentProject('/tmp/A copy.veproj')
      finish()
      await saving
      expect(useProjectStore.getState().currentFilePath).toBe('/tmp/A copy.veproj')
      expect(clearAutosave).not.toHaveBeenCalled()
    })
  }

  it('前の企画の「見つからない素材」の確認が遅れて届いても、開いた企画の印を消さない', async () => {
    const proj = (id: string, path: string): Project =>
      ({
        id,
        name: id,
        aspectRatio: '16:9',
        assets: [
          {
            id: id.toLowerCase(),
            filePath: path,
            fileName: path,
            duration: 10,
            width: 640,
            height: 360,
            fps: 30,
            hasAudio: true,
            hasVideo: true
          }
        ],
        clips: [],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: [],
        beatGrid: null
      }) as unknown as Project
    const pending: Record<string, (missing: string[]) => void> = {}
    vi.stubGlobal('window', {
      api: {
        loadProject: vi.fn(async (path: string) =>
          path === '/A.veproj' ? proj('A', '/a.mp4') : proj('B', '/b.mp4')
        ),
        checkFilesExist: vi.fn(
          (paths: string[]) =>
            new Promise<string[]>((resolve) => {
              pending[paths[0]] = resolve
            })
        ),
        discardAutosave: vi.fn(async () => undefined),
        checkAutosave: vi.fn(async () => ({ exists: false, discardedExists: false }))
      }
    })
    vi.stubGlobal('confirm', () => true)
    useProjectStore.setState({ isDirty: false })
    const openA = openRecentProject('/A.veproj')
    await new Promise((r) => setTimeout(r, 0))
    const openB = openRecentProject('/B.veproj')
    await new Promise((r) => setTimeout(r, 0))
    pending['/b.mp4'](['/b.mp4'])
    await openB
    pending['/a.mp4']([])
    await openA
    expect(useProjectStore.getState().missingAssetIds).toEqual(['b'])
  })
})

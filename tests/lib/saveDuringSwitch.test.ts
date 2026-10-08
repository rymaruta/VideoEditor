import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveProject, startNewProject } from '@renderer/lib/projectFileActions'
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
})

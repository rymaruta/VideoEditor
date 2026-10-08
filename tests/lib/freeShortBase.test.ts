import { afterEach, describe, expect, it, vi } from 'vitest'
import { freeShortBase } from '@renderer/store/pipelineStore'

describe('freeShortBase — ショートを置く名前', () => {
  afterEach(() => vi.unstubAllGlobals())
  const withExisting = (existing: string[]): void => {
    vi.stubGlobal('window', {
      api: {
        checkFilesExist: async (paths: string[]) => paths.filter((p) => !existing.includes(p))
      }
    })
  }
  it('同じ名前の企画・動画が無ければ、その名前', async () => {
    withExisting([])
    expect(await freeShortBase('/f/回 ショート1')).toBe('/f/回 ショート1')
  })
  it('前に作ったショート(企画か動画のどちらか)があれば、上書きせずに番号を付ける', async () => {
    withExisting(['/f/回 ショート1.veproj', '/f/回 ショート1 (2).mp4'])
    expect(await freeShortBase('/f/回 ショート1')).toBe('/f/回 ショート1 (3)')
  })
})

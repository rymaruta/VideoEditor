import { describe, expect, it, vi } from 'vitest'

// 設定・プリセットのストアは読み込み時に localStorage を読む
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
import { recordedAtByAsset } from '@renderer/store/pipelineStore'
import { recordedAtFromTags } from '@shared/ingest/recordedAt'
import type { SyncInputFile } from '@shared/sync/report'

describe('時刻スーパーの撮影時刻', () => {
  const ms = Date.parse('2026-09-01T10:00:00Z')

  it('素材の記録から読んだ時刻(秒)を ms にそろえる', () => {
    const project = {
      ...useProjectStore.getState().project,
      assets: [{ id: 'a', filePath: '/rec/a.mp4' }]
    } as unknown as Parameters<typeof recordedAtByAsset>[0]
    const synced = [
      {
        path: '/rec/a.mp4',
        recordedAt: recordedAtFromTags({ creation_time: '2026-09-01T10:00:00.000000Z' })
      }
    ] as unknown as SyncInputFile[]
    expect(recordedAtByAsset(project, synced).get('a')).toBe(ms)
  })

  it('前の版が秒で保存した企画の値も ms として読む', () => {
    const project = {
      ...useProjectStore.getState().project,
      assets: [],
      multicam: {
        anchorSourceId: 'A',
        sources: [{ id: 'A', name: 'カメラA', kind: 'camera' }],
        files: [
          { assetId: 'old', sourceId: 'A', start: 0, rate: 1, duration: 10, recordedAt: ms / 1000 },
          { assetId: 'new', sourceId: 'A', start: 10, rate: 1, duration: 10, recordedAt: ms }
        ]
      }
    } as unknown as Parameters<typeof recordedAtByAsset>[0]
    const got = recordedAtByAsset(project, [])
    expect(got.get('old')).toBe(ms)
    expect(got.get('new')).toBe(ms)
  })
})

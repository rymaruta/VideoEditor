import { describe, expect, it } from 'vitest'
import { useQcStore } from '@renderer/store/qcStore'
import { useProjectStore } from '@renderer/store/projectStore'
import type { QcMeasurement } from '@shared/qc/media'
import type { Project } from '@shared/types'

/** 監査の指摘 7: 次の書き出しで前の確認を止めるときの競合・自動のショートの「止めました」 */
const measurement = (): QcMeasurement => ({
  black: [],
  freeze: [],
  silence: [],
  loudness: null,
  duration: 7
})

let measured = 0
function stubApi(fonts?: Promise<void>): { resolve: (path: string) => void } {
  measured = 0
  const pending = new Map<string, { ok: (m: QcMeasurement) => void; ng: (e: Error) => void }>()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      onQcProgress: () => () => {},
      qcCancel: async () => {
        for (const [path, p] of pending) {
          pending.delete(path)
          p.ng(new Error('QC_CANCELED'))
        }
      },
      qcMeasure: (path: string) =>
        new Promise<QcMeasurement>((ok, ng) => {
          measured++
          if (pending.size > 0) return ng(new Error('自動確認はすでに実行中です'))
          pending.set(path, { ok, ng })
        })
    }
  }
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ getContext: () => null }),
    ...(fonts ? { fonts: { ready: fonts } } : {})
  }
  return {
    resolve: (path) => {
      const p = pending.get(path)
      pending.delete(path)
      p?.ok(measurement())
    }
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const project = {
  id: 'p',
  name: 'qc',
  aspectRatio: '16:9',
  assets: [],
  clips: [],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: [],
  beatGrid: null
} as unknown as Project

describe('次の書き出しで前の確認を止める', () => {
  it('書体の読み込みを待っている間に次の書き出しを始めても、書き出しの最中に測り始めない', async () => {
    let fontsReady: () => void = () => {}
    stubApi(new Promise<void>((r) => (fontsReady = r)))
    useQcStore.setState({ report: null })
    useProjectStore.setState({ project })
    const first = useQcStore.getState().run('/out/a.mp4', 'off', project)
    await tick()
    expect(measured).toBe(0)
    await useQcStore.getState().stopForExport()
    fontsReady()
    await first
    await tick()
    // 前は止まらず、書き出しの最中に測り始めていた
    expect(measured).toBe(0)
  })

  it('自動のショート(確認をしない書き出し)で止めたことは、次の手動の書き出しの確認に残さない', async () => {
    const api = stubApi()
    useQcStore.setState({ report: null })
    useProjectStore.setState({ project })
    const first = useQcStore.getState().run('/out/a.mp4', 'off', project)
    await tick()
    await useQcStore.getState().stopForExport({ note: false })
    await first
    const second = useQcStore.getState().run('/out/b.mp4', 'off', project)
    await tick()
    await tick()
    api.resolve('/out/b.mp4')
    await second
    expect(useQcStore.getState().report?.state).toBe('done')
    expect(useQcStore.getState().report?.stopped).toBeUndefined()
  })
})

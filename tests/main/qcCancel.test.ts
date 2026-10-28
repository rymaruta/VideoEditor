import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

/**
 * 試し編集 第2回の不具合 9: 書き出しの直後に次の書き出しを始めると、前の自動確認を止める。止めた ffmpeg は
 * SIGTERM を受けて自分で終わり、終了コード 255 を返すので「自動確認に失敗しました(255)」と記録されていた。
 * 止めたときは「止めた」(QC_CANCELED)と返す
 */
class FakeChild extends EventEmitter {
  stderr = new EventEmitter()
  kill = vi.fn(() => {
    // ffmpeg は SIGTERM を受けると後始末をして 255 で終わる
    setTimeout(() => this.emit('close', 255), 0)
    return true
  })
}
let child: FakeChild | null = null

vi.mock('child_process', () => ({
  spawn: () => {
    child = new FakeChild()
    return child
  }
}))
vi.mock('../../src/main/ffmpegService', () => ({
  ffmpegPath: 'ffmpeg',
  probeMedia: async () => ({ duration: 10, hasVideo: true, hasAudio: true })
}))
vi.mock('../../src/main/liveProcesses', () => ({
  trackProcess: () => () => {},
  stopNow: (p: { kill: (s: string) => unknown }) => p.kill('SIGKILL')
}))

describe('自動確認を止めたときは「止めた」と返す', () => {
  it('止めた ffmpeg が 255 で終わっても、失敗(255)にしない', async () => {
    const { measureExport, cancelMeasureExport } = await import('../../src/main/qcService')
    const p = measureExport('/out/a.mp4', () => {})
    // ffmpeg を立ち上げるまで待つ
    for (let i = 0; i < 20 && !child; i++) await new Promise((r) => setTimeout(r, 0))
    expect(child).not.toBeNull()
    cancelMeasureExport()
    await expect(p).rejects.toThrow('QC_CANCELED')
  })

  it('止めていないのに 255 で終わったときは、今までどおり失敗', async () => {
    child = null
    const { measureExport } = await import('../../src/main/qcService')
    const p = measureExport('/out/b.mp4', () => {})
    for (let i = 0; i < 20 && !child; i++) await new Promise((r) => setTimeout(r, 0))
    child!.emit('close', 255)
    await expect(p).rejects.toThrow('自動確認に失敗しました(255)')
  })
})

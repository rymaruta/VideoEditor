import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeCommand extends EventEmitter {
  kill = vi.fn()
}

describe('trackUntilDone', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('閉じた後に遅れて起きた fluent-ffmpeg の処理も止める', async () => {
    const { trackUntilDone, killLiveProcesses } = await import('../../src/main/liveProcesses')
    const p = trackUntilDone(new FakeCommand(), ['end', 'error'])
    killLiveProcesses()
    // fluent-ffmpeg は `.run()` の後で ffmpeg を起こす。起こす前の kill は何もしない
    const before = p.kill.mock.calls.length
    p.emit('start', 'ffmpeg ...')
    expect(p.kill.mock.calls.length).toBe(before + 1)
    expect(p.kill).toHaveBeenLastCalledWith('SIGKILL')
  })

  it('閉じていなければ、起きた処理は止めない', async () => {
    const { trackUntilDone } = await import('../../src/main/liveProcesses')
    const p = trackUntilDone(new FakeCommand(), ['end', 'error'])
    p.emit('start', 'ffmpeg ...')
    expect(p.kill).not.toHaveBeenCalled()
  })
})

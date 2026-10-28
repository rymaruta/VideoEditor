import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILD_KIND_KEY,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  readBuildKind,
  startAutoUpdate,
  updateCheckPlan,
  type UpdaterLike
} from '@main/autoUpdate'

/** electron-updater の autoUpdater の偽物 */
class FakeUpdater implements UpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = false
  checks = 0
  installs: [boolean | undefined, boolean | undefined][] = []
  fail: Error | null = null
  private listeners = new Map<string, ((arg: never) => void)[]>()
  on(event: string, listener: (arg: never) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  emit(event: string, arg: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(arg as never)
  }
  async checkForUpdates(): Promise<unknown> {
    this.checks++
    if (this.fail) throw this.fail
    return null
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter])
  }
}

const releaseWin = {
  isPackaged: true,
  platform: 'win32',
  buildKind: 'release' as const,
  env: {}
}

describe('自動更新: どの版が更新を確かめるか', () => {
  it('製品の package.json の印を読む(無い・知らない値は開発中)', () => {
    expect(BUILD_KIND_KEY).toBe('videoEditorBuild')
    expect(readBuildKind({ videoEditorBuild: 'release' })).toBe('release')
    expect(readBuildKind({ videoEditorBuild: 'personal' })).toBe('personal')
    for (const v of [
      {},
      null,
      undefined,
      'x',
      { videoEditorBuild: 'RELEASE' },
      { videoEditorBuild: 1 }
    ])
      expect(readBuildKind(v)).toBe('dev')
  })

  it('正式版・Windows・インストールした物だけが確かめる', () => {
    expect(updateCheckPlan(releaseWin)).toEqual({ check: true })
  })

  it('持ち主が試す版(personal)は確かめない(正式版で置き換えられない)', () => {
    const plan = updateCheckPlan({ ...releaseWin, buildKind: 'personal' })
    expect(plan.check).toBe(false)
    expect(plan.check === false && plan.reason).toMatch(/personal/)
  })

  it('開発中・macOS・Linux・VE_DISABLE_AUTO_UPDATE=1 は確かめない', () => {
    expect(updateCheckPlan({ ...releaseWin, isPackaged: false }).check).toBe(false)
    expect(updateCheckPlan({ ...releaseWin, buildKind: 'dev' }).check).toBe(false)
    expect(updateCheckPlan({ ...releaseWin, platform: 'darwin' }).check).toBe(false)
    expect(updateCheckPlan({ ...releaseWin, platform: 'linux' }).check).toBe(false)
    expect(updateCheckPlan({ ...releaseWin, env: { VE_DISABLE_AUTO_UPDATE: '1' } }).check).toBe(
      false
    )
    expect(updateCheckPlan({ ...releaseWin, env: { VE_DISABLE_AUTO_UPDATE: '0' } }).check).toBe(
      true
    )
  })
})

describe('自動更新: 確かめ方', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(plan = updateCheckPlan(releaseWin)): {
    updater: FakeUpdater
    loadUpdater: () => Promise<FakeUpdater>
    ask: ReturnType<typeof vi.fn<(version: string) => Promise<'restart' | 'later'>>>
    log: ReturnType<typeof vi.fn>
    requestQuit: ReturnType<typeof vi.fn>
    handle: ReturnType<typeof startAutoUpdate>
  } {
    const updater = new FakeUpdater()
    const loadUpdater = vi.fn(async () => updater)
    const ask = vi.fn<(version: string) => Promise<'restart' | 'later'>>(async () => 'later')
    const log = vi.fn()
    const requestQuit = vi.fn()
    const handle = startAutoUpdate(plan, { loadUpdater, ask, log, requestQuit })
    return { updater, loadUpdater, ask, log, requestQuit, handle }
  }

  it('確かめない版では electron-updater を読みもしない', async () => {
    const s = setup(updateCheckPlan({ ...releaseWin, buildKind: 'personal' }))
    expect(s.handle).toBeNull()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3)
    expect(s.loadUpdater).not.toHaveBeenCalled()
    expect(s.updater.checks).toBe(0)
    expect(s.log.mock.calls[0][0]).toMatch(/personal/)
  })

  it('起動してしばらくしてから確かめ、その後は間を置いて確かめる。裏でダウンロードし終了時に入れる', async () => {
    const s = setup()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1)
    expect(s.updater.checks).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.updater.checks).toBe(1)
    expect(s.updater.autoDownload).toBe(true)
    expect(s.updater.autoInstallOnAppQuit).toBe(true)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(s.updater.checks).toBe(2)
    s.handle?.stop()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(s.updater.checks).toBe(2)
  })

  it('確かめるのに失敗しても(ネットが無いなど)記録するだけで、次の回も確かめる', async () => {
    const s = setup()
    s.updater.fail = new Error('net::ERR_INTERNET_DISCONNECTED')
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(s.log).toHaveBeenCalledWith('自動更新: 確かめられませんでした', s.updater.fail)
    s.updater.fail = null
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(s.updater.checks).toBe(2)
    s.handle?.stop()
  })

  it('electron-updater を読めなくても落ちない', async () => {
    const log = vi.fn()
    const handle = startAutoUpdate(updateCheckPlan(releaseWin), {
      loadUpdater: async () => {
        throw new Error('Cannot find module')
      },
      ask: async () => 'later',
      log,
      requestQuit: () => undefined
    })
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(log.mock.calls[0][0]).toMatch(/読めませんでした/)
    handle?.stop()
  })

  it('ダウンロードし終えたら 1 回だけ尋ね、「あとで」なら今は入れない(終了したときに入る)', async () => {
    const s = setup()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    s.updater.emit('update-downloaded', { version: '1.2.0' })
    s.updater.emit('update-downloaded', { version: '1.2.0' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.ask).toHaveBeenCalledWith('1.2.0')
    expect(s.updater.installs).toEqual([])
    expect(s.requestQuit).not.toHaveBeenCalled()
    s.handle?.onWillQuit()
    expect(s.updater.installs).toEqual([])
    s.handle?.stop()
  })

  it('「再起動して更新」はまずいつもどおり終了を始め、終了まで進んだときだけ入れて起動し直す', async () => {
    const s = setup()
    s.ask.mockResolvedValue('restart')
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    s.updater.emit('update-downloaded', { version: '1.2.0' })
    await vi.advanceTimersByTimeAsync(0)
    // 保存していない変更の確かめより先にインストーラを動かさない
    expect(s.updater.installs).toEqual([])
    expect(s.requestQuit).toHaveBeenCalledTimes(1)
    s.handle?.onWillQuit()
    expect(s.updater.installs).toEqual([[false, true]])
    // 2 度は入れない
    s.handle?.onWillQuit()
    expect(s.updater.installs).toEqual([[false, true]])
    s.handle?.stop()
  })
})

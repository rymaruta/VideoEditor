import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * 【レグレッション】2026-10-21 元ファイルを同じ名前で差し替えたあとの古いプロキシ。
 * 同梱の ffmpeg で実際にプロキシを作り、元ファイルを別テイク(長さの違う動画)へ差し替えて、
 * 保存されていたプロキシが「古い」と判定されること・作り直したプロキシが新しいテイクの長さに
 * なることを確かめる。修正前は判定する手段が無く、開き直すと古いプロキシ(2秒)のまま
 * プレビューしていた(書き出しは新しい 4 秒のファイルを読む)
 */
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { ffmpegPath, probeMedia } from '@main/ffmpegService'
import { checkPreviewProxy, ensurePreviewProxy } from '@main/previewProxyService'

const work = mkdtempSync(join(tmpdir(), 've-staleproxy-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

function take(path: string, color: string, seconds: number): void {
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=320x180:d=${seconds}:r=30`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    path
  ])
}

describe.skipIf(!existsSync(ffmpegPath))('元ファイルを差し替えたあとのプロキシ', () => {
  it('差し替えると保存されていたプロキシは stale になり、作り直すと新しいテイクのプロキシになる', async () => {
    const src = join(work, 'cam1.mp4')
    take(src, 'red', 2)
    const oldProxy = await ensurePreviewProxy(src)
    expect(checkPreviewProxy(src, oldProxy)).toBe('current')

    // 同じ名前の別テイク(4秒)に差し替える
    take(src, 'blue', 4)
    expect(checkPreviewProxy(src, oldProxy)).toBe('stale')
    // 古いプロキシは前のテイクのまま(これをプレビューし続けていた)
    expect((await probeMedia(oldProxy)).duration).toBeCloseTo(2, 0)

    const newProxy = await ensurePreviewProxy(src)
    expect(newProxy).not.toBe(oldProxy)
    expect(checkPreviewProxy(src, newProxy)).toBe('current')
    expect((await probeMedia(newProxy)).duration).toBeCloseTo(4, 0)
  }, 120_000)

  it('身元の記録が無い前の版のプロキシも、名前が今の元ファイルと合えば current(作り直さない)', async () => {
    const src = join(work, 'legacy.mp4')
    take(src, 'green', 2)
    const proxy = await ensurePreviewProxy(src)
    rmSync(`${proxy}.source.json`)
    expect(checkPreviewProxy(src, proxy)).toBe('current')
    // 差し替えると名前が合わなくなり、記録が無いので unverified(画面側は作り直す)
    take(src, 'yellow', 3)
    expect(checkPreviewProxy(src, proxy)).toBe('unverified')
  }, 120_000)
})

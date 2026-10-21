import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { checkPreviewProxy, sourceIdentity } from '@main/previewProxyService'

/**
 * 【レグレッション】2026-10-21 保存されていたプロキシが**今の**元ファイルから作ったものかを確かめる。
 * 以前は確かめる手段が無く、元ファイルを同じ名前で差し替えても古いプロキシ(前の撮影)で
 * プレビューし続けていた(書き出しは新しいファイルを読む)。ffmpeg を使わず、プロキシの隣の
 * 身元の記録(`<プロキシ>.source.json`)だけで判定を確かめる。実際に変換する通しは
 * `tests/e2e/staleProxyReplace.test.ts`
 */

const work = mkdtempSync(join(tmpdir(), 've-proxyid-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

const src = join(work, 'cam1.mov')
const proxy = join(work, 'proxy.mp4')

function record(): void {
  writeFileSync(`${proxy}.source.json`, JSON.stringify(sourceIdentity(src)))
}

describe('checkPreviewProxy — プロキシと元ファイルの身元の照合', () => {
  it('作ったときと同じ元ファイルなら current', () => {
    writeFileSync(src, 'TAKE-1')
    writeFileSync(proxy, 'PROXY')
    record()
    expect(checkPreviewProxy(src, proxy)).toBe('current')
  })

  it('【レグレッション】同じ名前の別テイクに差し替えたら stale', () => {
    writeFileSync(src, 'TAKE-1')
    record()
    writeFileSync(src, 'TAKE-2-LONGER')
    expect(checkPreviewProxy(src, proxy)).toBe('stale')
  })

  it('同じ大きさ・同じ更新時刻に揃えた差し替えも、中身の目印で stale', () => {
    writeFileSync(src, 'TAKE-1')
    utimesSync(src, 1_700_000_000, 1_700_000_000)
    record()
    writeFileSync(src, 'TAKE-2')
    utimesSync(src, 1_700_000_000, 1_700_000_000)
    expect(checkPreviewProxy(src, proxy)).toBe('stale')
  })

  it('記録の無い前の版のプロキシで、名前も今の元ファイルと合わなければ unverified(作り直す側)', () => {
    rmSync(`${proxy}.source.json`, { force: true })
    expect(checkPreviewProxy(src, proxy)).toBe('unverified')
  })

  it('元ファイルが見つからなければ sourceMissing(比べようが無いので外さない)', () => {
    expect(checkPreviewProxy(join(work, 'moved.mov'), proxy)).toBe('sourceMissing')
  })

  it('壊れた記録は無いものとして扱う', () => {
    writeFileSync(`${proxy}.source.json`, '{not json')
    expect(checkPreviewProxy(src, proxy)).toBe('unverified')
  })
})

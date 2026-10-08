import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** 解析・試聴用の素材作りの失敗は、英語の生のログではなく短い日本語で出す */
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { ffmpegPath } from '@main/ffmpegService'
import { cachedEnvelope } from '@main/audioPcm'
import { ensurePreviewProxy } from '@main/previewProxyService'

const work = mkdtempSync(join(tmpdir(), 've-jaerr-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe.skipIf(!existsSync(ffmpegPath))('失敗の文面', () => {
  const notMedia = join(work, 'not-media.mp4')
  writeFileSync(notMedia, 'これは動画ではありません'.repeat(100))

  it('音の大きさの解析: 動画でないファイルは日本語の短い文面', async () => {
    const st = statSync(notMedia)
    const err = await cachedEnvelope(ffmpegPath, join(work, 'cache'), {
      path: notMedia,
      size: st.size,
      mtimeMs: st.mtimeMs
    }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/対応していない形式|壊れています/)
    expect((err as Error).message).not.toMatch(/Error opening|Invalid data/)
  })

  it('試聴用の素材: 調べられないファイルは日本語の短い文面(ffprobe の版数・ビルド設定を出さない)', async () => {
    const err = await ensurePreviewProxy(notMedia).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/^素材を調べられませんでした/)
    expect((err as Error).message.length).toBeLessThan(120)
    expect((err as Error).message).not.toMatch(/configuration:|ffprobe version/)
  })
})

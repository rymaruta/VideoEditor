import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath } from '@main/ffmpegService'
import { measureEncodedLoudness } from '@main/encodedLoudness'

/**
 * 【レグレッション 2026-10】AAC にした音を測る ffmpeg が先に終わると、書き出しが止まったまま戻らなかった。
 *
 * AAC にする側の出力を測る側へ pipe していたので、測る側が死ぬと pipe が外れ、AAC にする側は
 * 読まれない書き込みで止まったまま終わらなかった(監査: 60 秒の音で 20 秒経っても戻らない)。
 * 測る側が先に終わったら、AAC にする側も止めて null を返す
 */
describe.skipIf(process.platform === 'win32')('measureEncodedLoudness(測る側が先に終わる)', () => {
  const dir = mkdtempSync(join(tmpdir(), 've-meter-exit-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('測る側が少し読んで失敗しても、止まらずに null を返す', async () => {
    // 測る側(ebur128 を使う呼び出し)だけ、4KB 読んで失敗する ffmpeg
    const wrap = join(dir, 'ffmpeg')
    writeFileSync(
      wrap,
      `#!/bin/sh\ncase "$*" in *ebur128*) head -c 4096 >/dev/null; exit 1;; esac\nexec "${ffmpegPath}" "$@"\n`
    )
    chmodSync(wrap, 0o755)
    const started = Date.now()
    const r = await measureEncodedLoudness(
      wrap,
      ['-f', 'lavfi', '-i', 'sine=d=60:r=48000'],
      'volume=0dB'
    )
    expect(r).toBeNull()
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 30_000)

  it('ふつうの ffmpeg なら測れる', async () => {
    const r = await measureEncodedLoudness(
      ffmpegPath,
      ['-f', 'lavfi', '-i', 'sine=d=5:r=48000'],
      'volume=0dB'
    )
    expect(r).not.toBeNull()
    expect(Number.isFinite(r!.integrated)).toBe(true)
  }, 30_000)
})

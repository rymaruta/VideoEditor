import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false, getAppPath: () => process.cwd() }
}))

import { ffmpegPath } from '@main/ffmpegService'
import { scanShowKit } from '@main/showKitService'

const work = mkdtempSync(join(tmpdir(), 've-kit-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe.skipIf(!existsSync(ffmpegPath))('素材キットのフォルダ名', () => {
  it('全角の「ＢＧＭ」・濁点を分けた名前(NFD)のフォルダも読む', async () => {
    const tone = (dir: string): void => {
      mkdirSync(dir, { recursive: true })
      execFileSync(ffmpegPath, [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=f=440:d=1',
        join(dir, 'a.wav')
      ])
    }
    tone(join(work, 'SE', 'ツッコミ'))
    tone(join(work, 'ＢＧＭ', '楽しい'))
    const cg = join(work, 'グラフィック'.normalize('NFD'), 'テスト')
    mkdirSync(cg, { recursive: true })
    execFileSync(ffmpegPath, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x64:d=1',
      '-frames:v',
      '1',
      join(cg, 'x.png')
    ])
    const kit = await scanShowKit(work)
    const keys = (r: Record<string, unknown>): string[] => Object.keys(r)
    const k = kit as unknown as Record<'se' | 'bgm' | 'cg', Record<string, unknown>>
    expect(keys(k.se)).toEqual(['ツッコミ'])
    expect(keys(k.bgm)).toEqual(['楽しい'])
    expect(keys(k.cg).map((x) => x.normalize('NFC'))).toEqual(['テスト'])
  }, 60_000)
})

describe('素材キットのフォルダが無いとき', () => {
  it('空として読まずに知らせる(自動の SE・BGM を黙って外さない)', async () => {
    await expect(scanShowKit(join(work, 'not-here'))).rejects.toThrow(
      '番組素材フォルダが見つかりません'
    )
  })
})

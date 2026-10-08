import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const save = vi.hoisted(() => ({ fail: false }))
vi.mock('../../src/main/projectFileService', () => ({
  saveProjectFile: (path: string, project: unknown) => {
    if (save.fail) throw new Error('ENOSPC: no space left on device')
    writeFileSync(path, JSON.stringify(project))
  }
}))

import { discardedPathFor, writeAutosaveFile } from '../../src/main/autosaveFiles'
import type { Project } from '../../src/shared/types'

const dirs: string[] = []
afterEach(() => {
  save.fail = false
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const setup = (): string => {
  const d = mkdtempSync(join(tmpdir(), 've-autosave-'))
  dirs.push(d)
  return join(d, 'autosave.veproj')
}
const proj = (name: string): Project => ({ name }) as unknown as Project

describe('writeAutosaveFile', () => {
  it('書き込みが失敗しても、退避したことは呼び出し側に伝える', () => {
    const path = setup()
    writeFileSync(path, 'PREVIOUS')
    save.fail = true
    let setAside = false
    expect(() =>
      writeAutosaveFile(path, proj('CUR'), true, {
        onSetAside: () => {
          setAside = true
        }
      })
    ).toThrow()
    expect(setAside).toBe(true)
    expect(readFileSync(discardedPathFor(path), 'utf8')).toBe('PREVIOUS')
  })

  it('前に退避したもの(前回の作業)を残すよう頼まれたら、日時付きの名前で残す', () => {
    const path = setup()
    writeFileSync(discardedPathFor(path), 'PREVIOUS')
    writeFileSync(path, 'CRASHED')
    expect(writeAutosaveFile(path, proj('NEW'), true, { keepPreviousDiscarded: true })).toBe(true)
    expect(readFileSync(discardedPathFor(path), 'utf8')).toBe('CRASHED')
    const dir = join(path, '..')
    const kept = readdirSync(dir).filter((f) => /^autosave-discarded-.+\.veproj$/.test(f))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dir, kept[0]), 'utf8')).toBe('PREVIOUS')
  })
})

describe('setAsideAutosaveFile', () => {
  it('破棄・開く・終了の経路でも、前に退避した前回の作業を日時付きの名前で残せる', async () => {
    const { setAsideAutosaveFile } = await import('../../src/main/autosaveFiles')
    const path = setup()
    writeFileSync(discardedPathFor(path), 'PREVIOUS')
    writeFileSync(path, 'CRASHED')
    expect(setAsideAutosaveFile(path, true)).toBe(true)
    expect(readFileSync(discardedPathFor(path), 'utf8')).toBe('CRASHED')
    const dir = join(path, '..')
    const kept = readdirSync(dir).filter((f) => /^autosave-discarded-.+\.veproj$/.test(f))
    expect(kept.map((f) => readFileSync(join(dir, f), 'utf8'))).toEqual(['PREVIOUS'])
  })
})

describe('自動保存の失敗の文面', () => {
  it('退避の失敗(同じ名前のフォルダ)は、英語の生のエラーではなく日本語', async () => {
    const { mkdirSync } = await import('fs')
    const path = setup()
    writeFileSync(path, 'PREVIOUS')
    // 退避先に中身のあるフォルダがある
    mkdirSync(join(discardedPathFor(path), 'x'), { recursive: true })
    const err = (() => {
      try {
        writeAutosaveFile(path, proj('CUR'), true)
      } catch (e) {
        return e as Error
      }
      return null
    })()
    expect(err).not.toBeNull()
    expect(err!.message).toBe('自動保存の置き場所に同じ名前のフォルダがあります')
  })
})

describe('自動保存の退避の失敗の文面(破棄・開く・新規・保存)', () => {
  it('退避先に中身のあるフォルダがあっても、英語の生のエラーではなく日本語', async () => {
    const { mkdirSync } = await import('fs')
    const { setAsideAutosaveFile } = await import('../../src/main/autosaveFiles')
    const path = setup()
    writeFileSync(path, 'PREVIOUS')
    mkdirSync(join(discardedPathFor(path), 'x'), { recursive: true })
    expect(() => setAsideAutosaveFile(path, false)).toThrow(
      '自動保存の置き場所に同じ名前のフォルダがあります'
    )
  })
})

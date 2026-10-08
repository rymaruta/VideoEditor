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
